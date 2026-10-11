#!/usr/bin/env python3
"""Receive a bounded release before serializing root-owned deployment tools."""
import fcntl
import hashlib
import json
import os
import pathlib
import re
import selectors
import secrets
import signal
import stat
import subprocess
import sys
import tempfile
import tarfile
import time
from release_archive import MAX_BYTES, validate_archive


ROOT = pathlib.Path('/var/lib/puzarchive-deploy')
RELEASE_SCRIPT = '/usr/local/lib/puzarchive-deploy/remote-release.sh'
IDLE_SECONDS = 120
RECEIVE_SECONDS = 900
CACHE_UID = CACHE_GID = 0
FONT_NAME = re.compile(r'assets/fonts/[A-Za-z0-9][A-Za-z0-9._-]*\.woff2')
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
                else:
                    return True
            except OSError:
                self.fd = None
        return False

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


class FontCache:
    """Only verified, root-owned content-addressed font objects are reusable."""
    def __init__(self, path):
        path = pathlib.Path(path)
        # Hold the directory itself, rather than following its pathname later.
        parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.fd = None
        try:
            self.check_directory(parent)
            try:
                os.mkdir(path.name, mode=0o700, dir_fd=parent)
            except FileExistsError:
                pass
            self.fd = os.open(path.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                              dir_fd=parent)
            self.check_directory(self.fd)
        except BaseException:
            if self.fd is not None:
                os.close(self.fd)
            raise
        finally:
            os.close(parent)

    @staticmethod
    def check_directory(fd):
        info = os.fstat(fd)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != CACHE_UID
                or info.st_gid != CACHE_GID or stat.S_IMODE(info.st_mode) != 0o700):
            raise ValueError('untrusted font cache directory')

    def __enter__(self):
        return self

    def __exit__(self, *_):
        os.close(self.fd)

    @staticmethod
    def name(digest):
        if not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
            raise ValueError('invalid font cache identity')
        return digest + '.woff2'

    def read(self, digest, size, check_progress):
        try:
            fd = os.open(self.name(digest), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                         dir_fd=self.fd)
        except FileNotFoundError:
            return None
        with os.fdopen(fd, 'rb') as source:
            info = os.fstat(source.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != CACHE_UID
                    or info.st_gid != CACHE_GID or stat.S_IMODE(info.st_mode) != 0o600
                    or info.st_nlink != 1):
                raise ValueError('untrusted font cache object')
            if info.st_size != size:
                return None
            body = bytearray()
            while True:
                check_progress()
                block = source.read(min(65536, size + 1 - len(body)))
                if not block:
                    break
                body.extend(block)
                if len(body) > size:
                    return None
        if len(body) != size or hashlib.sha256(body).hexdigest() != digest:
            return None
        return bytes(body)

    def store(self, body, check_cancelled):
        digest = hashlib.sha256(body).hexdigest()
        if self.read(digest, len(body), check_cancelled) is not None:
            return
        name, temporary = self.name(digest), '.pending-' + secrets.token_hex(16)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=self.fd)
        try:
            with os.fdopen(fd, 'wb') as output:
                for position in range(0, len(body), 65536):
                    check_cancelled()
                    output.write(body[position:position + 65536])
                output.flush()
                os.fsync(output.fileno())
            check_cancelled()
            os.replace(temporary, name, src_dir_fd=self.fd, dst_dir_fd=self.fd)
            os.fsync(self.fd)
        finally:
            try:
                os.unlink(temporary, dir_fd=self.fd)
            except FileNotFoundError:
                pass


def cache_references(request):
    cache = request['font_cache']
    if (not isinstance(cache, dict) or set(cache) != {'version', 'archive_bytes', 'fonts'}
            or type(cache['version']) is not int or cache['version'] != 1
            or type(cache['archive_bytes']) is not int or not 0 < cache['archive_bytes'] <= MAX_BYTES
            or not isinstance(cache['fonts'], list) or len(cache['fonts']) > 32):
        raise ValueError('invalid font cache request')
    end = 0
    for ref in cache['fonts']:
        if (not isinstance(ref, dict) or set(ref) != {'offset', 'bytes', 'sha256'}
                or type(ref['offset']) is not int or type(ref['bytes']) is not int
                or ref['offset'] < end or ref['offset'] % 512 or ref['bytes'] < 4
                or ref['offset'] + ref['bytes'] > cache['archive_bytes']
                or not isinstance(ref['sha256'], str)
                or not re.fullmatch(r'[0-9a-f]{64}', ref['sha256'])):
            raise ValueError('invalid font cache reference')
        end = ref['offset'] + ref['bytes']
    return cache['fonts']


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate release header key')
        result[key] = value
    return result


def receive_release(fd, archive, idle_seconds, receive_seconds, check_cancelled, forward,
                    font_cache=None):
    header, request = bytearray(), None
    digest, size = hashlib.sha256(), 0
    hits, next_hit = [], 0
    started = progress = time.monotonic()

    def check_progress():
        check_cancelled()
        now = time.monotonic()
        if now - started >= receive_seconds:
            forward.emit('deployment_gateway_receive_timeout=true')
            raise TimeoutError('release receive deadline exceeded')
        if now - progress >= idle_seconds:
            forward.emit('deployment_gateway_receive_idle_timeout=true')
            raise TimeoutError('release input made no progress')

    os.set_blocking(fd, False)
    with archive.open('xb') as output, selectors.DefaultSelector() as selector:
        def write(block):
            nonlocal size
            size += len(block)
            limit = request['font_cache']['archive_bytes'] if 'font_cache' in request else MAX_BYTES
            if size > limit:
                raise ValueError('release too large')
            digest.update(block)
            output.write(block)

        def insert_cached():
            nonlocal next_hit
            while next_hit < len(hits) and hits[next_hit][0]['offset'] == size:
                _, body = hits[next_hit]
                for position in range(0, len(body), 65536):
                    check_progress()
                    write(body[position:position + 65536])
                next_hit += 1

        selector.register(fd, selectors.EVENT_READ)
        while True:
            check_progress()
            now = time.monotonic()
            wait = min(1, receive_seconds - (now - started), idle_seconds - (now - progress))
            if not selector.select(wait):
                continue
            try:
                block = os.read(fd, 65536)
            except BlockingIOError:
                continue
            if not block:
                check_progress()
                insert_cached()
                break
            progress = time.monotonic()
            if request is None:
                boundary = block.find(b'\n')
                header.extend(block if boundary < 0 else block[:boundary + 1])
                if len(header) > 4096:
                    raise ValueError('invalid release header')
                if boundary < 0:
                    continue
                request = json.loads(header, object_pairs_hook=unique_keys)
                if (not isinstance(request, dict)
                        or set(request) not in ({'commit', 'sha256'}, {'commit', 'sha256', 'font_cache'})
                        or not re.fullmatch(r'[0-9a-f]{40}', request['commit'])
                        or not re.fullmatch(r'[0-9a-f]{64}', request['sha256'])):
                    raise ValueError('invalid release identity')
                if 'font_cache' in request:
                    if font_cache is None:
                        raise ValueError('font cache transport unavailable')
                    refs = cache_references(request)
                    reuse = []
                    for index, ref in enumerate(refs):
                        check_progress()
                        body = font_cache.read(ref['sha256'], ref['bytes'], check_progress)
                        if body is not None:
                            reuse.append(index)
                            hits.append((ref, body))
                    response = 'deployment_gateway_font_cache=' + json.dumps(
                        {'reuse': reuse}, separators=(',', ':'))
                    if not forward.emit(response):
                        raise ValueError('font cache negotiation output unavailable')
                    request['_font_cache_reuse'] = reuse
                block = block[boundary + 1:]
            while block:
                insert_cached()
                count = min(len(block), hits[next_hit][0]['offset'] - size) if next_hit < len(hits) else len(block)
                write(block[:count])
                block = block[count:]
    if (request is None or digest.hexdigest() != request['sha256']
            or ('font_cache' in request and size != request['font_cache']['archive_bytes'])):
        raise ValueError('incomplete release or checksum mismatch')
    return request


def validate_and_cache_fonts(archive, request, cache, check_cancelled, forward):
    # The complete archive identity and manifest have already passed validation.
    fonts = []
    with tarfile.open(archive, 'r:') as tar:
        for member in tar.getmembers():
            check_cancelled()
            if member.isfile() and FONT_NAME.fullmatch(member.name):
                body = tar.extractfile(member).read()
                if body[:4] != b'wOF2':
                    raise ValueError('invalid font object')
                fonts.append(({'offset': member.offset_data, 'bytes': member.size,
                               'sha256': hashlib.sha256(body).hexdigest()}, body))
    if 'font_cache' in request:
        refs = request['font_cache']['fonts']
        if refs != [ref for ref, _ in fonts]:
            raise ValueError('font references do not match verified archive')
    for _, body in fonts:
        check_cancelled()
        cache.store(body, check_cancelled)
    if 'font_cache' in request:
        # Each hit was read from an immutable in-memory snapshot before negotiation.
        reused = request.pop('_font_cache_reuse', [])
        refs = request['font_cache']['fonts']
        reused_bytes = sum(refs[index]['bytes'] for index in reused)
        forward.emit('font_cache_reused_files=' + str(len(reused)))
        forward.emit('font_cache_reused_bytes=' + str(reused_bytes))
        forward.emit('font_cache_transferred_files=' + str(len(refs) - len(reused)))
        forward.emit('font_cache_transferred_bytes=' + str(sum(ref['bytes'] for ref in refs) - reused_bytes))


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
        with FontCache(root / 'font-cache') as cache, tempfile.TemporaryDirectory(prefix='incoming-', dir=root) as incoming:
            archive = pathlib.Path(incoming, 'release.tar')
            forward.emit('deployment_gateway_receiving=true')
            request = receive_release(input_fd, archive, idle_seconds, receive_seconds,
                                      check_cancelled, forward, font_cache=cache)
            check_cancelled()
            validate_archive(archive, request['commit'])
            check_cancelled()
            validate_and_cache_fonts(archive, request, cache, check_cancelled, forward)
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
