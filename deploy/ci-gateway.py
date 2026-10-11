#!/usr/bin/env python3
"""Receive a bounded release before serializing root-owned deployment tools."""
import fcntl
import hashlib
import json
import os
import pathlib
import re
import selectors
import signal
import subprocess
import sys
import tempfile
import time
from release_archive import MAX_BYTES, validate_archive


ROOT = pathlib.Path('/var/lib/puzarchive-deploy')
RELEASE_SCRIPT = '/usr/local/lib/puzarchive-deploy/remote-release.sh'
IDLE_SECONDS = 120
RECEIVE_SECONDS = 600
SAFE_RELEASE_LINE = re.compile(
    r'(?:release_already_active|deployed_commit)=[0-9a-f]{40}'
    r'|(?:baseline_tables|baseline_rows|preservation_mismatch_count|foreign_key_violations)=\d+'
    r'|(?:all_old_fields_equal|backup_and_live_integrity_ok|member_configuration_unchanged'
    r'|preservation_check_failed|service_active|environment_and_member_configuration_unchanged'
    r'|deployment_failed_code_rollback_complete|database_and_member_files_not_restored_or_overwritten)=(?:true|false)'
    r'|loopback_home_http=200|unauthenticated_private_api_http=401|private_source_http=404'
)


class Cancelled(Exception):
    def __init__(self, signum):
        self.signum = signum


class Forwarder:
    """A slow or disconnected SSH output must not hold up the release."""
    def __init__(self, fd):
        self.fd = fd
        self.pending = bytearray()
        self.discarding = False
        os.set_blocking(fd, False)

    def emit(self, line):
        if self.fd is not None:
            try:
                body = (line + '\n').encode()
                if os.write(self.fd, body) != len(body):
                    self.fd = None
            except OSError:
                self.fd = None

    def line(self):
        if not self.discarding:
            line = self.pending.decode('utf-8', 'replace').rstrip('\r')
            if SAFE_RELEASE_LINE.fullmatch(line):
                self.emit(line)
            elif line.startswith('Created private backup: '):
                self.emit('private_backup_created=true')
        self.pending.clear()
        self.discarding = False

    def consume(self, block):
        for byte in block:
            if byte == 10:
                self.line()
            elif not self.discarding:
                if len(self.pending) == 4096:
                    self.pending.clear()
                    self.discarding = True
                else:
                    self.pending.append(byte)


def receive_release(fd, archive, idle_seconds, receive_seconds, check_cancelled, forward):
    header, request = bytearray(), None
    digest, size = hashlib.sha256(), 0
    started = progress = time.monotonic()
    os.set_blocking(fd, False)
    with archive.open('xb') as output, selectors.DefaultSelector() as selector:
        selector.register(fd, selectors.EVENT_READ)
        while True:
            check_cancelled()
            now = time.monotonic()
            if now - started >= receive_seconds:
                forward.emit('deployment_gateway_receive_timeout=true')
                raise TimeoutError('release receive deadline exceeded')
            if now - progress >= idle_seconds:
                forward.emit('deployment_gateway_receive_idle_timeout=true')
                raise TimeoutError('release input made no progress')
            wait = min(1, receive_seconds - (now - started), idle_seconds - (now - progress))
            if not selector.select(wait):
                continue
            try:
                block = os.read(fd, 65536)
            except BlockingIOError:
                continue
            if not block:
                check_cancelled()
                break
            progress = time.monotonic()
            if request is None:
                boundary = block.find(b'\n')
                header.extend(block if boundary < 0 else block[:boundary + 1])
                if len(header) > 4096:
                    raise ValueError('invalid release header')
                if boundary < 0:
                    continue
                request = json.loads(header)
                if (not re.fullmatch(r'[0-9a-f]{40}', request['commit'])
                        or not re.fullmatch(r'[0-9a-f]{64}', request['sha256'])):
                    raise ValueError('invalid release identity')
                block = block[boundary + 1:]
            size += len(block)
            if size > MAX_BYTES:
                raise ValueError('release too large')
            digest.update(block)
            output.write(block)
    if request is None or digest.hexdigest() != request['sha256']:
        raise ValueError('incomplete release or checksum mismatch')
    return request


def main(root=ROOT, release_script=RELEASE_SCRIPT, idle_seconds=IDLE_SECONDS,
         receive_seconds=RECEIVE_SECONDS, input_fd=0, output_fd=1):
    if os.getuid() != 0:
        raise ValueError('gateway must run as root')
    root = pathlib.Path(root)
    root.mkdir(mode=0o700, exist_ok=True)
    forward = Forwarder(output_fd)
    cancellation = 0

    def on_cancel(signum, _frame):
        nonlocal cancellation
        cancellation = cancellation or signum

    def check_cancelled():
        if cancellation:
            raise Cancelled(cancellation)

    signals = (signal.SIGHUP, signal.SIGINT, signal.SIGTERM)
    previous = {signum: signal.signal(signum, on_cancel) for signum in signals}
    try:
        with tempfile.TemporaryDirectory(prefix='incoming-', dir=root) as incoming:
            archive = pathlib.Path(incoming, 'release.tar')
            forward.emit('deployment_gateway_receiving=true')
            request = receive_release(input_fd, archive, idle_seconds, receive_seconds,
                                      check_cancelled, forward)
            check_cancelled()
            validate_archive(archive, request['commit'])
            check_cancelled()
            forward.emit('deployment_gateway_received=true')
            with (root / 'deploy.lock').open('a') as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    forward.emit('deployment_gateway_busy=true')
                    raise
                check_cancelled()
                # Child output and the lock outlive a disconnected or killed parent.
                log_path = pathlib.Path(incoming, 'release.log')
                with log_path.open('xb', buffering=0) as log, log_path.open('rb', buffering=0) as tail:
                    check_cancelled()
                    process = subprocess.Popen(
                        ['/bin/bash', str(release_script), incoming, request['commit'], request['sha256']],
                        stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                        start_new_session=True, pass_fds=(lock.fileno(),))
                    # Signals now only record cancellation; finish deployment or rollback.
                    try:
                        forward.emit('deployment_gateway_release_started=true')
                        while True:
                            block = tail.read(65536)
                            if block:
                                forward.consume(block)
                                continue
                            if process.poll() is not None:
                                # Drain bytes written between the read and the exit check.
                                while block := tail.read(65536):
                                    forward.consume(block)
                                forward.line()
                                break
                            time.sleep(0.05)
                    finally:
                        # Keep incoming and the parent lock even if forwarding fails.
                        result = process.wait()
                if cancellation:
                    forward.emit('deployment_gateway_cancelled=true')
                    return 128 + cancellation
                if result:
                    raise subprocess.CalledProcessError(result, 'remote-release')
        return 0
    except Cancelled as error:
        forward.emit('deployment_gateway_cancelled=true')
        return 128 + error.signum
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def entrypoint(**fixture_options):
    os.umask(0o077)
    try:
        return main(**fixture_options)
    except Exception:
        # Do not serialize request bodies, credentials, paths, or database values.
        print('deployment_gateway_failed=true', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(entrypoint())
