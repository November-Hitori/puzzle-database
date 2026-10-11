"""Send a verified release to the forced SSH deployment command."""
import hashlib
import json
import math
import os
import pathlib
import re
import selectors
import signal
import subprocess
import sys
import tarfile
import time
from release_archive import MAX_BYTES, validate_archive


def cancel_transfer(signum, _frame):
    sys.exit(128 + signum)


signal.signal(signal.SIGTERM, cancel_transfer)


PHASES = (
    (r'^debug1: Connection established\.$', 'tcp_connected'),
    (r"^debug1: Host '.*' is known and matches the \S+ host key\.$", 'host_key_matched'),
    (r'^Authenticated to .* using "[^"]+"\.$', 'authenticated'),
    (r'^debug2: channel \d+: open confirm rwindow \d+ rmax \d+$', 'session_channel_open'),
    (r'^debug2: (?:shell|exec) request accepted on channel \d+$', 'session_request_accepted'),
)
ERRORS = (
    (r'Host key verification failed\.|REMOTE HOST IDENTIFICATION HAS CHANGED', 'host_key_verification_failed'),
    (r'No .* host key is known for .* and you have requested strict checking\.', 'host_key_untrusted'),
    (r'Permission denied \([^)]*\)\.|Authentication failed\.', 'authentication_failed'),
    (r'Connection timed out|Operation timed out', 'connection_timeout'),
    (r'^Timeout, server .* not responding\.$', 'server_not_responding'),
    (r'Connection refused', 'connection_refused'),
    (r'Connection reset by peer', 'connection_reset'),
    (r'Connection .*closed by remote host', 'connection_closed'),
    (r'Broken pipe', 'broken_pipe'),
    (r'Could not resolve hostname', 'name_resolution_failed'),
    (r'(?:shell|exec) request failed on channel \d+', 'session_request_failed'),
    (r'Load key .*:', 'key_load_failed'),
)

SAFE_GATEWAY_LINE = re.compile(
    r'deployment_gateway_(?:receiving|received|receive_timeout|receive_idle_timeout'
    r'|busy|release_started|cancelled|failed)=true'
    r'|(?:release_already_active|deployed_commit)=[0-9a-f]{40}'
    r'|(?:baseline_tables|baseline_rows|preservation_mismatch_count|foreign_key_violations)=\d+'
    r'|font_cache_(?:reused_files|reused_bytes|transferred_files|transferred_bytes)=\d+'
    r'|(?:all_old_fields_equal|backup_and_live_integrity_ok|member_configuration_unchanged'
    r'|preservation_check_failed|service_active|environment_and_member_configuration_unchanged'
    r'|deployment_failed_code_rollback_complete|database_and_member_files_not_restored_or_overwritten'
    r'|private_backup_created)=(?:true|false)'
    r'|loopback_home_http=200|unauthenticated_private_api_http=401|private_source_http=404'
)
CACHE_RESPONSE_PREFIX = 'deployment_gateway_font_cache='


def font_references(archive, payload, metadata):
    """Reference only verified font content, keeping every tar header and pad byte."""
    if len(payload) > MAX_BYTES:
        raise ValueError('release too large')
    refs = []
    with tarfile.open(archive, 'r:') as tar:
        for member in tar.getmembers():
            if not (member.isfile() and re.fullmatch(r'assets/fonts/[A-Za-z0-9][A-Za-z0-9._-]*\.woff2', member.name)):
                continue
            start, size = member.offset_data, member.size
            body = payload[start:start + size]
            digest = hashlib.sha256(body).hexdigest()
            if (start % 512 or size < 4 or start + size > len(payload)
                    or body[:4] != b'wOF2' or digest != metadata['files'][member.name]):
                raise ValueError('invalid release font')
            refs.append({'offset': start, 'bytes': size, 'sha256': digest})
    refs.sort(key=lambda ref: ref['offset'])
    if len(refs) > 32 or any(left['offset'] + left['bytes'] > right['offset']
                              for left, right in zip(refs, refs[1:])):
        raise ValueError('invalid release font references')
    return refs


def cached_payload(payload, refs, response):
    """Reject ambiguous cache replies before transmitting any source content."""
    def unique_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate cache response key')
            result[key] = value
        return result

    reply = json.loads(response, object_pairs_hook=unique_keys)
    if not isinstance(reply, dict) or set(reply) != {'reuse'} or not isinstance(reply['reuse'], list):
        raise ValueError('invalid cache response')
    indices = reply['reuse']
    if (any(type(index) is not int or index < 0 or index >= len(refs) for index in indices)
            or indices != sorted(set(indices))):
        raise ValueError('invalid cache references')
    pieces, cursor, reused_bytes = [], 0, 0
    for index in indices:
        ref = refs[index]
        pieces.append(payload[cursor:ref['offset']])
        cursor = ref['offset'] + ref['bytes']
        reused_bytes += ref['bytes']
    pieces.append(payload[cursor:])
    return b''.join(pieces), len(indices), reused_bytes


def diagnostic(line, observed, counters):
    # SSH debugging includes paths and fingerprints: never forward its raw text.
    counter = None
    if re.fullmatch(r'debug3: receive packet: type (?:81|82)', line):
        # Both global success and failure replies demonstrate control traffic.
        counter = 'ssh_control_reply_count'
    elif re.fullmatch(r'debug2: channel \d+: rcvd adjust \d+', line):
        counter = 'ssh_window_adjust_count'
    if counter:
        counters[counter] += 1
        print(counter + '=' + str(counters[counter]), flush=True)
        return
    if line == 'deployment_gateway_failed=true':
        print(line, flush=True)
    for patterns, name in ((PHASES, 'ssh_phase'), (ERRORS, 'ssh_error')):
        for pattern, value in patterns:
            marker = name + '=' + value
            if re.search(pattern, line) and marker not in observed:
                observed.add(marker)
                print(marker, flush=True)


def consume_diagnostics(block, pending, observed, counters, discarding):
    for byte in block:
        if byte == 10:
            if not discarding:
                diagnostic(pending.decode('utf-8', 'replace').rstrip('\r'), observed, counters)
            pending.clear()
            discarding = False
        elif not discarding:
            if len(pending) == 4096:
                pending.clear()
                discarding = True
            else:
                pending.append(byte)
    return discarding


try:
    if len(sys.argv) not in (3, 4):
        raise ValueError('invalid arguments')
    # Optional seconds argument lets isolated CLI tests use a short deadline.
    idle_seconds = float(sys.argv[3]) if len(sys.argv) == 4 else 120.0
    if not math.isfinite(idle_seconds) or idle_seconds <= 0:
        raise ValueError('invalid idle deadline')
    archive = pathlib.Path(sys.argv[1])
    metadata = validate_archive(archive)
    payload = archive.read_bytes()
    refs = font_references(archive, payload, metadata)
    request = {'commit': metadata['commit'], 'sha256': hashlib.sha256(payload).hexdigest(),
               'font_cache': {'version': 1, 'archive_bytes': len(payload), 'fonts': refs}}
    header = json.dumps(request, separators=(',', ':')).encode() + b'\n'
    if len(header) > 4096:
        raise ValueError('release header too large')
    process = subprocess.Popen(['ssh', '-C', '-vvv', '-o', 'ServerAliveInterval=15',
                                '-o', 'ServerAliveCountMax=3', '-F', sys.argv[2], 'puzarchive-production'],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, bufsize=0)
except Exception:
    sys.exit('release_sender_exit_code=1')

sender_exit_code = 0
pending, observed = bytearray(), set()
counters = {'ssh_control_reply_count': 0, 'ssh_window_adjust_count': 0}
discarding = False
remote_pending, remote_discarding = bytearray(), False
try:
    print('release_transfer_started=true', flush=True)
    print('release_payload_bytes=' + str(len(payload)), flush=True)
    print('ssh_phase=connecting', flush=True)
    for counter in counters:
        print(counter + '=0', flush=True)
    print('release_font_cache_candidates=' + str(len(refs)), flush=True)
    wire = memoryview(header)
    phase, handshake_started = 'header', None
    offset, reported = 0, -1
    last_write = last_report = time.monotonic()
    os.set_blocking(process.stdin.fileno(), False)
    os.set_blocking(process.stdout.fileno(), False)
    os.set_blocking(process.stderr.fileno(), False)
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdin, selectors.EVENT_WRITE, 'input')
        selector.register(process.stdout, selectors.EVENT_READ, 'gateway')
        selector.register(process.stderr, selectors.EVENT_READ, 'diagnostic')
        while selector.get_map() or process.poll() is None:
            now = time.monotonic()
            written = offset if phase in ('payload', 'done') else 0
            if reported < 0 or written - reported >= 262144 or now - last_report >= 15:
                print('local_payload_bytes_written=' + str(written), flush=True)
                reported, last_report = written, now
            if phase == 'await' and now - handshake_started >= idle_seconds:
                print('release_font_cache_handshake_timeout=true', flush=True)
                raise TimeoutError('cache handshake made no progress')
            if phase in ('header', 'payload') and now - last_write >= idle_seconds:
                print('local_payload_bytes_written=' + str(written), flush=True)
                print('release_transfer_idle_timeout=true', flush=True)
                raise TimeoutError('local input made no progress')
            deadline = handshake_started if phase == 'await' else last_write
            wait = min(1.0, max(0, idle_seconds - (now - deadline))) if phase != 'done' else 1.0
            for key, _ in selector.select(wait):
                if key.data == 'input':
                    try:
                        count = os.write(key.fd, wire[offset:offset + 65536])
                    except BlockingIOError:
                        continue
                    offset += count
                    if count:
                        last_write = time.monotonic()
                    if offset == len(wire):
                        selector.unregister(process.stdin)
                        if phase == 'header':
                            phase, handshake_started = 'await', time.monotonic()
                        else:
                            process.stdin.close()
                            phase = 'done'
                            print('local_payload_bytes_written=' + str(len(wire)), flush=True)
                            reported, last_report = len(wire), time.monotonic()
                            # Local SSH input completion does not confirm remote receipt.
                            print('local_stdin_closed=true', flush=True)
                elif key.data == 'gateway':
                    try:
                        block = os.read(key.fd, 4096)
                    except BlockingIOError:
                        continue
                    if not block:
                        selector.unregister(process.stdout)
                        process.stdout.close()
                        if phase in ('header', 'await'):
                            print('release_font_cache_handshake_failed=true', flush=True)
                            raise ValueError('cache handshake ended before reply')
                        if remote_pending and not remote_discarding:
                            line = remote_pending.decode('utf-8', 'replace').rstrip('\r')
                            if SAFE_GATEWAY_LINE.fullmatch(line):
                                print(line, flush=True)
                        continue
                    for byte in block:
                        if byte == 10:
                            if not remote_discarding:
                                line = remote_pending.decode('utf-8', 'replace').rstrip('\r')
                                if line.startswith(CACHE_RESPONSE_PREFIX):
                                    if phase != 'await':
                                        print('release_font_cache_handshake_failed=true', flush=True)
                                        raise ValueError('unexpected cache reply')
                                    try:
                                        reduced, reused, reused_bytes = cached_payload(
                                            payload, refs, line[len(CACHE_RESPONSE_PREFIX):])
                                    except (ValueError, TypeError, RecursionError):
                                        print('release_font_cache_handshake_failed=true', flush=True)
                                        raise
                                    wire, offset, phase = memoryview(reduced), 0, 'payload'
                                    last_write = time.monotonic()
                                    print('release_font_cache_reused=' + str(reused), flush=True)
                                    print('release_font_cache_reused_bytes=' + str(reused_bytes), flush=True)
                                    print('release_wire_payload_bytes=' + str(len(wire)), flush=True)
                                    selector.register(process.stdin, selectors.EVENT_WRITE, 'input')
                                elif SAFE_GATEWAY_LINE.fullmatch(line):
                                    print(line, flush=True)
                            remote_pending.clear()
                            remote_discarding = False
                        elif not remote_discarding:
                            if len(remote_pending) == 4095:
                                if remote_pending.startswith(CACHE_RESPONSE_PREFIX.encode()):
                                    print('release_font_cache_handshake_failed=true', flush=True)
                                    raise ValueError('cache response too large')
                                remote_pending.clear()
                                remote_discarding = True
                            else:
                                remote_pending.append(byte)
                else:
                    try:
                        block = os.read(key.fd, 4096)
                    except BlockingIOError:
                        continue
                    if not block:
                        if pending and not discarding:
                            diagnostic(pending.decode('utf-8', 'replace').rstrip('\r'), observed, counters)
                        selector.unregister(process.stderr)
                        process.stderr.close()
                        continue
                    discarding = consume_diagnostics(block, pending, observed, counters, discarding)
    process.wait()
except BaseException as error:
    process.kill()
    process.wait()
    sender_exit_code = 1
    if isinstance(error, KeyboardInterrupt):
        sender_exit_code = 130
    elif isinstance(error, SystemExit):
        sender_exit_code = error.code or 1
finally:
    try:
        process.stdin.close()
    except OSError:
        pass
    try:
        # Preserve buffered errors even when a broken input pipe was selected first.
        os.set_blocking(process.stderr.fileno(), False)
        while block := os.read(process.stderr.fileno(), 4096):
            discarding = consume_diagnostics(block, pending, observed, counters, discarding)
        if pending and not discarding:
            diagnostic(pending.decode('utf-8', 'replace').rstrip('\r'), observed, counters)
    except (OSError, ValueError):
        pass
    process.stderr.close()
    process.stdout.close()
    print('ssh_exit_code=' + str(process.returncode), flush=True)

sys.exit(sender_exit_code or (process.returncode if process.returncode >= 0 else 1))
