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
import time
from release_archive import validate_archive


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
    (r'Connection refused', 'connection_refused'),
    (r'Connection reset by peer', 'connection_reset'),
    (r'Connection .*closed by remote host', 'connection_closed'),
    (r'Broken pipe', 'broken_pipe'),
    (r'Could not resolve hostname', 'name_resolution_failed'),
    (r'(?:shell|exec) request failed on channel \d+', 'session_request_failed'),
    (r'Load key .*:', 'key_load_failed'),
)


def diagnostic(line, observed):
    # SSH debugging includes paths and fingerprints: never forward its raw text.
    if line == 'deployment_gateway_failed=true':
        print(line, flush=True)
    for patterns, name in ((PHASES, 'ssh_phase'), (ERRORS, 'ssh_error')):
        for pattern, value in patterns:
            marker = name + '=' + value
            if re.search(pattern, line) and marker not in observed:
                observed.add(marker)
                print(marker, flush=True)


def consume_diagnostics(block, pending, observed, discarding):
    for byte in block:
        if byte == 10:
            if not discarding:
                diagnostic(pending.decode('utf-8', 'replace').rstrip('\r'), observed)
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
    header = json.dumps({'commit': metadata['commit'], 'sha256': hashlib.sha256(payload).hexdigest()}).encode() + b'\n'
    process = subprocess.Popen(['ssh', '-C', '-vv', '-F', sys.argv[2], 'puzarchive-production'],
                               stdin=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
except Exception:
    sys.exit('release_sender_exit_code=1')

sender_exit_code = 0
pending, observed = bytearray(), set()
discarding = False
try:
    print('release_transfer_started=true', flush=True)
    print('release_payload_bytes=' + str(len(payload)), flush=True)
    print('ssh_phase=connecting', flush=True)
    wire = memoryview(header + payload)
    offset, reported = 0, -1
    last_write = last_report = time.monotonic()
    os.set_blocking(process.stdin.fileno(), False)
    os.set_blocking(process.stderr.fileno(), False)
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdin, selectors.EVENT_WRITE, 'input')
        selector.register(process.stderr, selectors.EVENT_READ, 'diagnostic')
        while selector.get_map() or process.poll() is None:
            now = time.monotonic()
            written = max(0, offset - len(header))
            if reported < 0 or written - reported >= 262144 or now - last_report >= 15:
                print('local_payload_bytes_written=' + str(written), flush=True)
                reported, last_report = written, now
            if offset < len(wire) and now - last_write >= idle_seconds:
                print('local_payload_bytes_written=' + str(written), flush=True)
                print('release_transfer_idle_timeout=true', flush=True)
                raise TimeoutError('local input made no progress')
            wait = min(1.0, max(0, idle_seconds - (now - last_write))) if offset < len(wire) else 1.0
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
                        process.stdin.close()
                        print('local_payload_bytes_written=' + str(len(payload)), flush=True)
                        reported, last_report = len(payload), time.monotonic()
                        # Local SSH input completion does not confirm remote receipt.
                        print('local_stdin_closed=true', flush=True)
                else:
                    try:
                        block = os.read(key.fd, 4096)
                    except BlockingIOError:
                        continue
                    if not block:
                        if pending and not discarding:
                            diagnostic(pending.decode('utf-8', 'replace').rstrip('\r'), observed)
                        selector.unregister(process.stderr)
                        process.stderr.close()
                        continue
                    discarding = consume_diagnostics(block, pending, observed, discarding)
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
            discarding = consume_diagnostics(block, pending, observed, discarding)
        if pending and not discarding:
            diagnostic(pending.decode('utf-8', 'replace').rstrip('\r'), observed)
    except (OSError, ValueError):
        pass
    process.stderr.close()
    print('ssh_exit_code=' + str(process.returncode), flush=True)

sys.exit(sender_exit_code or (process.returncode if process.returncode >= 0 else 1))
