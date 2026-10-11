import ctypes
import fcntl
import hashlib
import io
import json
import copy
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest


GATEWAY = Path(__file__).parents[1] / 'deploy' / 'ci-gateway.py'
COMMIT = 'b' * 40
WRAPPER = '''import importlib.util, os, pathlib, sys, time
sys.path.insert(0, str(pathlib.Path(sys.argv[1]).parent))
spec = importlib.util.spec_from_file_location('fixture_gateway', sys.argv[1])
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)
gateway.CACHE_UID = os.getuid()
gateway.CACHE_GID = os.getgid()
if len(sys.argv) > 6 and sys.argv[6] == 'wrong-cache-owner':
    gateway.CACHE_UID += 1
gateway.os.getuid = lambda: 0
if len(sys.argv) > 6 and sys.argv[6] == 'forward-fail':
    original = gateway.Forwarder.consume
    def failed_forward(self, block):
        original(self, block)
        raise OSError('SENSITIVE_FIXTURE_ERROR')
    gateway.Forwarder.consume = failed_forward
if len(sys.argv) > 6 and sys.argv[6] == 'slow-cache':
    original_read = gateway.FontCache.read
    def slow_read(self, digest, size, check_progress):
        body = original_read(self, digest, size, check_progress)
        time.sleep(0.25)
        check_progress()
        return body
    gateway.FontCache.read = slow_read
sys.exit(gateway.entrypoint(root=sys.argv[2], release_script=sys.argv[3],
                           idle_seconds=float(sys.argv[4]), receive_seconds=float(sys.argv[5])))
'''
HELPER = '''import hashlib, json, os, pathlib, stat, sys
root = pathlib.Path(__file__).parent
incoming = pathlib.Path(sys.argv[1])
payload = (incoming / 'release.tar').read_bytes()
(root / 'received.tar').write_bytes(payload)
mode = (root / 'mode').read_text()
gate = os.open(root / 'gate', os.O_RDWR) if mode == 'hold' else None
lock_inode = (root / 'gateway' / 'deploy.lock').stat().st_ino
has_lock_fd = False
for entry in pathlib.Path('/proc/self/fd').iterdir():
    try:
        has_lock_fd |= os.fstat(int(entry.name)).st_ino == lock_inode
    except OSError:
        pass
(root / 'child.json').write_text(json.dumps({
    'pid': os.getpid(), 'sid': os.getsid(0), 'pgid': os.getpgrp(),
    'commit': sys.argv[2], 'checksum': sys.argv[3],
    'hash': hashlib.sha256(payload).hexdigest(),
    'stdin_eof': sys.stdin.buffer.read() == b'', 'has_lock_fd': has_lock_fd,
    'incoming': str(incoming), 'directory_mode': stat.S_IMODE(incoming.stat().st_mode),
    'log_mode': stat.S_IMODE((incoming / 'release.log').stat().st_mode)}))
print('service_active=true', flush=True)
print('Created private backup: /SENSITIVE_BACKUP_PATH', flush=True)
print('private_backup_directory=/SENSITIVE_BACKUP_PATH', flush=True)
print('SENSITIVE_MEMBER_VALUE', file=sys.stderr, flush=True)
print('baseline_rows=7', flush=True)
if gate is not None:
    os.read(gate, 1)
    os.close(gate)
if mode == 'fail':
    print('preservation_check_failed=true', file=sys.stderr, flush=True)
    sys.exit(23)
(root / 'child_done').write_text('complete')
sys.stdout.write('deployed_commit=' + sys.argv[2])
sys.stdout.flush()
'''


@unittest.skipUnless(sys.platform == 'linux', 'gateway deployment uses Linux flock and process sessions')
class CiGatewayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Reap the orphaned fixture child after deliberately killing its parent.
        cls.libc = ctypes.CDLL(None, use_errno=True)
        original = ctypes.c_int()
        if cls.libc.prctl(37, ctypes.byref(original), 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), 'cannot query fixture subreaper')
        cls.original_subreaper = original.value
        if cls.libc.prctl(36, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), 'cannot adopt fixture child')

    @classmethod
    def tearDownClass(cls):
        cls.libc.prctl(36, cls.original_subreaper, 0, 0, 0)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='puzarchive-gateway-fixture-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.gateway_root = self.root / 'gateway'
        self.gateway_root.mkdir(mode=0o700)
        self.helper = self.root / 'release.sh'
        self.helper.write_text('exec ' + sys.executable + ' "$(dirname -- "$0")/helper.py" "$@"\n')
        (self.root / 'helper.py').write_text(HELPER)
        (self.root / 'mode').write_text('done')
        os.mkfifo(self.root / 'gate', 0o600)
        self.processes = []
        self.addCleanup(self.stop_fixtures)

    def stop_fixtures(self):
        for process in self.processes:
            if process.poll() is None:
                process.kill()
            process.wait()
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None:
                    stream.close()
        state = self.root / 'child.json'
        if state.exists():
            pid = json.loads(state.read_text())['pid']
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass

    def archive(self, corrupt=False, fonts=None):
        sources = {'server.mjs': b'fixture server', 'db.mjs': b'fixture database',
                   'docs/penpa.md': b'fixture spec', 'binary.dat': bytes(range(256)) * 128}
        sources.update(fonts or {})
        hashes = {name: hashlib.sha256(body).hexdigest() for name, body in sources.items()}
        if corrupt:
            sources['db.mjs'] += b' changed after manifest'
        sources['.release.json'] = json.dumps({'commit': COMMIT, 'files': hashes}).encode()
        result = io.BytesIO()
        with tarfile.open(fileobj=result, mode='w') as tar:
            for name, body in sources.items():
                member = tarfile.TarInfo(name)
                member.mode = 0o644
                member.size = len(body)
                tar.addfile(member, io.BytesIO(body))
            data = tarfile.TarInfo('data')
            data.type = tarfile.DIRTYPE
            data.mode = 0o755
            tar.addfile(data)
        return result.getvalue()

    def wire(self, payload=None):
        payload = self.archive() if payload is None else payload
        header = json.dumps({'commit': COMMIT, 'sha256': hashlib.sha256(payload).hexdigest()}).encode()
        return header + b'\n' + payload

    def font_archive(self, changed=False):
        return self.archive(fonts={
            'assets/fonts/example-regular.woff2': b'wOF2' + bytes(range(256)) * 300,
            'assets/fonts/example-bold.woff2': b'wOF2' + (b'new' if changed else b'old') * 17003,
        })

    def cached_request(self, payload):
        refs = []
        with tarfile.open(fileobj=io.BytesIO(payload), mode='r:') as archive:
            for member in archive.getmembers():
                if member.name.startswith('assets/fonts/') and member.name.endswith('.woff2'):
                    body = archive.extractfile(member).read()
                    refs.append({'offset': member.offset_data, 'bytes': member.size,
                                 'sha256': hashlib.sha256(body).hexdigest()})
        return {'commit': COMMIT, 'sha256': hashlib.sha256(payload).hexdigest(),
                'font_cache': {'version': 1, 'archive_bytes': len(payload), 'fonts': refs}}

    def cache_body(self, payload, request, reuse):
        body, position = bytearray(), 0
        for index in reuse:
            ref = request['font_cache']['fonts'][index]
            body.extend(payload[position:ref['offset']])
            position = ref['offset'] + ref['bytes']
        body.extend(payload[position:])
        return bytes(body)

    def negotiate(self, process, request):
        process.stdin.write(json.dumps(request, separators=(',', ':')).encode() + b'\n')
        process.stdin.flush()
        marker = b'deployment_gateway_font_cache='
        self.wait_marker(process, marker)
        line = next(line for line in process.fixture_prefix.splitlines() if line.startswith(marker))
        return json.loads(line[len(marker):])['reuse']

    def cached_send(self, payload):
        request = self.cached_request(payload)
        process = self.start()
        reuse = self.negotiate(process, request)
        result = self.finish(process, self.cache_body(payload, request, reuse))
        return reuse, result

    def reset_release_state(self):
        for name in ('child.json', 'child_done', 'received.tar'):
            (self.root / name).unlink(missing_ok=True)

    def assert_cache_empty(self):
        cache = self.gateway_root / 'font-cache'
        if cache.exists() and not cache.is_symlink():
            self.assertFalse(list(cache.iterdir()))

    def start(self, idle_seconds=1, receive_seconds=3, mode='normal'):
        process = subprocess.Popen([sys.executable, '-c', WRAPPER, str(GATEWAY),
                                    str(self.gateway_root), str(self.helper),
                                    str(idle_seconds), str(receive_seconds), mode],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        process.fixture_prefix = b''
        self.processes.append(process)
        return process

    def wait_marker(self, process, marker):
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            deadline = time.monotonic() + 5
            while marker not in process.fixture_prefix:
                ready = selector.select(max(0, deadline - time.monotonic()))
                self.assertTrue(ready, 'fixture did not reach expected phase')
                block = os.read(process.stdout.fileno(), 4096)
                self.assertTrue(block, 'gateway exited before expected phase')
                process.fixture_prefix += block

    def finish(self, process, wire=None):
        stdout, stderr = process.communicate(input=wire, timeout=5)
        return process.returncode, process.fixture_prefix + (stdout or b''), stderr

    def send(self, wire):
        return self.finish(self.start(), wire)

    def feed_and_close(self, process, wire):
        process.stdin.write(wire)
        process.stdin.close()
        process.stdin = None

    def assert_lock_free(self):
        with (self.gateway_root / 'deploy.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def assert_lock_busy(self):
        with (self.gateway_root / 'deploy.lock').open('a') as lock:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def assert_no_release(self):
        self.assertFalse((self.root / 'child.json').exists())
        self.assertFalse(list(self.gateway_root.glob('incoming-*')))
        self.assert_lock_free()

    def release_gate(self):
        fd = os.open(self.root / 'gate', os.O_WRONLY | os.O_NONBLOCK)
        try:
            os.write(fd, b'1')
        finally:
            os.close(fd)

    def start_held_release(self, mode='normal'):
        for name in ('child.json', 'child_done'):
            (self.root / name).unlink(missing_ok=True)
        (self.root / 'mode').write_text('hold')
        process = self.start(mode=mode)
        self.feed_and_close(process, self.wire())
        self.wait_marker(process, b'service_active=true\n')
        return process, json.loads((self.root / 'child.json').read_text())

    def test_binary_protocol_eof_and_safe_release_output(self):
        payload = self.archive()
        code, stdout, stderr = self.send(self.wire(payload))
        self.assertEqual(code, 0, stderr.decode())
        self.assertEqual((self.root / 'received.tar').read_bytes(), payload)
        state = json.loads((self.root / 'child.json').read_text())
        self.assertEqual(state['commit'], COMMIT)
        self.assertEqual(state['checksum'], hashlib.sha256(payload).hexdigest())
        self.assertEqual(state['checksum'], state['hash'])
        self.assertTrue(state['stdin_eof'])
        self.assertTrue(state['has_lock_fd'])
        self.assertEqual(state['pid'], state['sid'])
        self.assertEqual(state['pid'], state['pgid'])
        self.assertEqual(state['directory_mode'], 0o700)
        self.assertEqual(state['log_mode'], 0o600)
        self.assertIn(b'private_backup_created=true', stdout)
        self.assertIn(b'baseline_rows=7', stdout)
        self.assertIn(b'deployed_commit=' + COMMIT.encode(), stdout)
        self.assertNotIn(b'SENSITIVE_', stdout + stderr)
        self.assertNotIn(str(self.root).encode(), stdout + stderr)
        self.assertFalse(list(self.gateway_root.glob('incoming-*')))
        self.assert_lock_free()

    def test_legacy_release_populates_cache_and_warm_release_reconstructs_identical_tar(self):
        payload = self.font_archive()
        code, _, stderr = self.send(self.wire(payload))
        self.assertEqual(code, 0, stderr.decode())
        request = self.cached_request(payload)
        cache = self.gateway_root / 'font-cache'
        self.assertEqual(cache.stat().st_mode & 0o777, 0o700)
        for ref in request['font_cache']['fonts']:
            obj = cache / (ref['sha256'] + '.woff2')
            self.assertEqual(obj.stat().st_mode & 0o777, 0o600)
            self.assertEqual(obj.stat().st_uid, os.getuid())
            self.assertEqual(obj.stat().st_gid, os.getgid())
            self.assertEqual(obj.stat().st_size, ref['bytes'])
            self.assertEqual(hashlib.sha256(obj.read_bytes()).hexdigest(), ref['sha256'])
        reuse, (code, stdout, stderr) = self.cached_send(payload)
        self.assertEqual(code, 0, stderr.decode())
        self.assertEqual(reuse, [0, 1])
        self.assertEqual((self.root / 'received.tar').read_bytes(), payload)
        self.assertEqual(json.loads((self.root / 'child.json').read_text())['hash'], request['sha256'])
        self.assertIn(b'font_cache_reused_files=2\n', stdout)
        self.assertIn(b'font_cache_transferred_files=0\n', stdout)
        self.assertIn(b'font_cache_transferred_bytes=0\n', stdout)
        self.assertNotIn(b'SENSITIVE_', stdout + stderr)
        self.assertLess(len(self.cache_body(payload, request, reuse)), len(payload) // 3)
        self.assertFalse(list(cache.glob('.pending-*')))
        self.assert_lock_free()

    def test_cold_cache_changed_font_and_corrupt_object_are_transmitted_and_repaired(self):
        payload = self.font_archive()
        refs = self.cached_request(payload)['font_cache']['fonts']
        reuse, (code, stdout, stderr) = self.cached_send(payload)
        self.assertEqual(code, 0, stderr.decode())
        self.assertEqual(reuse, [])
        self.assertIn(b'font_cache_transferred_files=2\n', stdout)
        changed = self.font_archive(changed=True)
        reuse, (code, stdout, stderr) = self.cached_send(changed)
        self.assertEqual(code, 0, stderr.decode())
        self.assertEqual(reuse, [0])
        self.assertIn(b'font_cache_reused_files=1\n', stdout)
        self.assertIn(b'font_cache_transferred_files=1\n', stdout)
        cache = self.gateway_root / 'font-cache'
        old = cache / (refs[1]['sha256'] + '.woff2')
        self.assertTrue(old.is_file(), 'old font objects remain available for older releases')
        damaged = cache / (refs[0]['sha256'] + '.woff2')
        damaged.write_bytes(b'x' * refs[0]['bytes'])
        reuse, (code, _, stderr) = self.cached_send(changed)
        self.assertEqual(code, 0, stderr.decode())
        self.assertEqual(reuse, [1])
        self.assertEqual(hashlib.sha256(damaged.read_bytes()).hexdigest(), refs[0]['sha256'])
        self.assertEqual((self.root / 'received.tar').read_bytes(), changed)
        damaged.write_bytes(b'truncated')
        reuse, (code, _, stderr) = self.cached_send(changed)
        self.assertEqual(code, 0, stderr.decode())
        self.assertEqual(reuse, [1])
        self.assertEqual(damaged.stat().st_size, refs[0]['bytes'])

    def test_new_protocol_without_fonts_still_negotiates_empty_reuse(self):
        payload = self.archive()
        reuse, (code, stdout, stderr) = self.cached_send(payload)
        self.assertEqual(code, 0, stderr.decode())
        self.assertEqual(reuse, [])
        self.assertIn(b'deployment_gateway_font_cache={"reuse":[]}\n', stdout)
        self.assertEqual((self.root / 'received.tar').read_bytes(), payload)
        self.assert_cache_empty()

    def test_malformed_cache_headers_fail_before_release_or_cache_population(self):
        request = self.cached_request(self.font_archive())
        cases = []
        for field, value in [('version', True), ('version', 2), ('archive_bytes', True),
                             ('archive_bytes', 0), ('archive_bytes', 32 * 1024 * 1024 + 1),
                             ('fonts', 'invalid'), ('fonts', [request['font_cache']['fonts'][0]] * 33)]:
            invalid = copy.deepcopy(request)
            invalid['font_cache'][field] = value
            cases.append(invalid)
        for field, value in [('offset', True), ('offset', -1), ('offset', 513), ('bytes', False),
                             ('bytes', 0), ('bytes', 3), ('bytes', len(self.font_archive()) + 1),
                             ('sha256', '../unsafe'), ('sha256', 'A' * 64)]:
            invalid = copy.deepcopy(request)
            invalid['font_cache']['fonts'][0][field] = value
            cases.append(invalid)
        invalid = copy.deepcopy(request)
        invalid['font_cache']['fonts'].reverse()
        cases.append(invalid)
        invalid = copy.deepcopy(request)
        invalid['font_cache']['fonts'][1]['offset'] = invalid['font_cache']['fonts'][0]['offset']
        cases.append(invalid)
        invalid = copy.deepcopy(request)
        invalid['font_cache'] = None
        cases.append(invalid)
        for invalid in cases:
            with self.subTest(cache=invalid['font_cache']):
                code, stdout, stderr = self.send(json.dumps(invalid, separators=(',', ':')).encode() + b'\n')
                self.assertNotEqual(code, 0)
                self.assertNotIn(b'deployment_gateway_font_cache=', stdout)
                self.assertIn(b'deployment_gateway_failed=true', stderr)
                self.assert_no_release()
                self.assert_cache_empty()

    def test_valid_tar_with_misidentified_font_refs_does_not_populate_cache(self):
        payload = self.font_archive()
        for defect in ('offset', 'size', 'digest', 'missing', 'foreign'):
            with self.subTest(defect=defect):
                request = self.cached_request(payload)
                refs = request['font_cache']['fonts']
                if defect == 'offset':
                    refs[0]['offset'] -= 512
                elif defect == 'size':
                    refs[0]['bytes'] -= 1
                elif defect == 'digest':
                    refs[0]['sha256'] = 'f' * 64
                elif defect == 'missing':
                    refs.pop()
                else:
                    refs[0] = {'offset': 512, 'bytes': 14,
                               'sha256': hashlib.sha256(payload[512:526]).hexdigest()}
                process = self.start()
                self.assertEqual(self.negotiate(process, request), [])
                code, stdout, _ = self.finish(process, payload)
                self.assertNotEqual(code, 0)
                self.assertNotIn(b'deployment_gateway_release_started=true', stdout)
                self.assert_no_release()
                self.assert_cache_empty()

    def test_duplicate_identity_cache_or_reference_keys_fail_before_negotiation(self):
        request = self.cached_request(self.font_archive())
        header = json.dumps(request, separators=(',', ':'))
        cache_json = json.dumps(request['font_cache'], separators=(',', ':'))
        cases = [
            header.replace('"commit":', '"commit":"' + COMMIT + '","commit":', 1),
            header.replace('"font_cache":', '"font_cache":' + cache_json + ',"font_cache":', 1),
            header.replace('"version":1', '"version":1,"version":1', 1),
            header.replace('"offset":', '"offset":0,"offset":', 1),
        ]
        for body in cases:
            with self.subTest(header=body[:100]):
                code, stdout, stderr = self.send(body.encode() + b'\n')
                self.assertNotEqual(code, 0)
                self.assertNotIn(b'deployment_gateway_font_cache=', stdout)
                self.assertIn(b'deployment_gateway_failed=true', stderr)
                self.assert_no_release()
                self.assert_cache_empty()

    def test_corrupt_or_truncated_or_extra_wire_bytes_never_fill_cold_cache(self):
        payload = self.font_archive()
        for defect in ('digest', 'manifest', 'commit', 'truncated', 'extra'):
            with self.subTest(defect=defect):
                body = payload
                if defect == 'manifest':
                    body = self.archive(corrupt=True, fonts={'assets/fonts/one.woff2': b'wOF2fixture'})
                request = self.cached_request(body)
                if defect == 'digest':
                    request['sha256'] = 'f' * 64
                elif defect == 'commit':
                    request['commit'] = 'a' * 40
                elif defect == 'truncated':
                    body = body[:-1]
                elif defect == 'extra':
                    body += b'x'
                process = self.start()
                self.assertEqual(self.negotiate(process, request), [])
                code, stdout, _ = self.finish(process, body)
                self.assertNotEqual(code, 0)
                self.assertNotIn(b'deployment_gateway_release_started=true', stdout)
                self.assert_no_release()
                self.assert_cache_empty()

    def test_cache_directory_symlink_or_wrong_mode_or_owner_fails_closed(self):
        cache = self.gateway_root / 'font-cache'
        outside = self.root / 'outside'
        outside.mkdir(mode=0o700)
        cache.symlink_to(outside, target_is_directory=True)
        code, _, _ = self.send(self.wire())
        self.assertNotEqual(code, 0)
        self.assertFalse(list(outside.iterdir()))
        self.assert_no_release()
        cache.unlink()
        cache.mkdir(mode=0o755)
        code, _, _ = self.send(self.wire())
        self.assertNotEqual(code, 0)
        self.assert_no_release()
        cache.chmod(0o700)
        code, _, _ = self.finish(self.start(mode='wrong-cache-owner'), self.wire())
        self.assertNotEqual(code, 0)
        self.assert_no_release()

    def test_cache_symlink_fifo_directory_hardlink_or_wrong_mode_fails_closed(self):
        payload = self.font_archive()
        request = self.cached_request(payload)
        cache = self.gateway_root / 'font-cache'
        cache.mkdir(mode=0o700)
        path = cache / (request['font_cache']['fonts'][0]['sha256'] + '.woff2')
        outside = self.root / 'outside-font'
        outside.write_bytes(b'SENSITIVE_FIXTURE_FONT')
        outside.chmod(0o600)
        for defect in ('symlink', 'fifo', 'directory', 'hardlink', 'mode'):
            with self.subTest(defect=defect):
                if defect == 'symlink':
                    path.symlink_to(outside)
                elif defect == 'fifo':
                    os.mkfifo(path, 0o600)
                elif defect == 'directory':
                    path.mkdir(mode=0o600)
                elif defect == 'hardlink':
                    os.link(outside, path)
                else:
                    path.write_bytes(b'unsafe mode')
                    path.chmod(0o644)
                code, stdout, stderr = self.send(json.dumps(request).encode() + b'\n')
                self.assertNotEqual(code, 0)
                self.assertNotIn(b'deployment_gateway_font_cache=', stdout)
                self.assertNotIn(b'SENSITIVE_', stdout + stderr)
                self.assertEqual(outside.read_bytes(), b'SENSITIVE_FIXTURE_FONT')
                self.assert_no_release()
                if defect == 'directory':
                    path.rmdir()
                else:
                    path.unlink()

    def test_cache_negotiation_requires_live_stdout_and_does_not_cache_partial_input(self):
        request = self.cached_request(self.font_archive())
        process = self.start()
        self.wait_marker(process, b'deployment_gateway_receiving=true\n')
        process.stdout.close()
        process.stdout = None
        code, _, stderr = self.finish(process, json.dumps(request).encode() + b'\n')
        self.assertNotEqual(code, 0)
        self.assertIn(b'deployment_gateway_failed=true', stderr)
        self.assert_no_release()
        self.assert_cache_empty()
        process = self.start()
        self.assertEqual(self.negotiate(process, request), [])
        process.stdin.write(self.font_archive()[:100])
        process.stdin.flush()
        process.send_signal(signal.SIGTERM)
        code, stdout, _ = self.finish(process)
        self.assertEqual(code, 128 + signal.SIGTERM)
        self.assertIn(b'deployment_gateway_cancelled=true', stdout)
        self.assert_no_release()
        self.assert_cache_empty()

    def test_cached_input_still_requires_eof_and_absolute_deadline(self):
        payload = self.font_archive()
        code, _, stderr = self.send(self.wire(payload))
        self.assertEqual(code, 0, stderr.decode())
        self.reset_release_state()
        request = self.cached_request(payload)
        process = self.start()
        reuse = self.negotiate(process, request)
        process.stdin.write(self.cache_body(payload, request, reuse))
        process.stdin.flush()
        process.wait(timeout=5)
        code, stdout, _ = self.finish(process)
        self.assertNotEqual(code, 0)
        self.assertIn(b'deployment_gateway_receive_idle_timeout=true', stdout)
        self.assert_no_release()
        process = self.start(idle_seconds=2, receive_seconds=0.1, mode='slow-cache')
        code, stdout, _ = self.finish(process, json.dumps(request).encode() + b'\n')
        self.assertNotEqual(code, 0)
        self.assertIn(b'deployment_gateway_receive_timeout=true', stdout)
        self.assertNotIn(b'deployment_gateway_font_cache=', stdout)
        self.assert_no_release()

    def test_partial_header_and_body_have_a_bounded_idle_failure(self):
        for fragment in (b'{"commit":', self.wire()[:-100]):
            with self.subTest(fragment_size=len(fragment)):
                process = self.start()
                self.wait_marker(process, b'deployment_gateway_receiving=true\n')
                process.stdin.write(fragment)
                process.stdin.flush()
                process.wait(timeout=5)
                code, stdout, stderr = self.finish(process)
                self.assertNotEqual(code, 0)
                self.assertIn(b'deployment_gateway_receive_idle_timeout=true', stdout)
                self.assertIn(b'deployment_gateway_failed=true', stderr)
                self.assert_no_release()

    def test_absolute_receive_deadline_is_not_extended_by_real_input_progress(self):
        process = self.start(idle_seconds=2, receive_seconds=1)
        self.wait_marker(process, b'deployment_gateway_receiving=true\n')
        started = time.monotonic()
        while process.poll() is None and time.monotonic() - started < 3:
            try:
                process.stdin.write(b' ')
                process.stdin.flush()
            except BrokenPipeError:
                break
            time.sleep(0.1)
        code, stdout, _ = self.finish(process)
        self.assertNotEqual(code, 0)
        self.assertIn(b'deployment_gateway_receive_timeout=true', stdout)
        self.assertNotIn(b'deployment_gateway_receive_idle_timeout=true', stdout)
        self.assert_no_release()

    def test_complete_archive_without_eof_does_not_start_a_release(self):
        process = self.start()
        process.stdin.write(self.wire())
        process.stdin.flush()
        process.wait(timeout=5)
        code, stdout, _ = self.finish(process)
        self.assertNotEqual(code, 0)
        self.assertNotIn(b'deployment_gateway_received=true', stdout)
        self.assert_no_release()

    def test_eof_truncation_identity_checksum_and_manifest_fail_before_release(self):
        wire = self.wire()
        invalid = (b'', b'{}\n', b'x' * 4097, wire[:30], wire[:-100],
                   wire[:-1] + bytes([wire[-1] ^ 1]), self.wire(self.archive(corrupt=True)))
        for body in invalid:
            with self.subTest(size=len(body)):
                code, stdout, stderr = self.send(body)
                self.assertNotEqual(code, 0)
                self.assertIn(b'deployment_gateway_failed=true', stderr)
                self.assertNotIn(b'deployment_gateway_release_started=true', stdout)
                self.assert_no_release()

    def test_busy_lock_is_checked_only_after_receiving_and_validating_the_archive(self):
        with (self.gateway_root / 'deploy.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            process = self.start()
            self.wait_marker(process, b'deployment_gateway_receiving=true\n')
            self.assertIsNone(process.poll())
            code, stdout, _ = self.finish(process, self.wire())
            self.assertNotEqual(code, 0)
            self.assertIn(b'deployment_gateway_received=true', stdout)
            self.assertIn(b'deployment_gateway_busy=true', stdout)
            code, stdout, _ = self.send(self.wire(self.archive(corrupt=True)))
            self.assertNotEqual(code, 0)
            self.assertNotIn(b'deployment_gateway_received=true', stdout)
            self.assertNotIn(b'deployment_gateway_busy=true', stdout)
        self.assert_no_release()

    def test_cancellation_before_eof_cleans_input_without_starting_a_child(self):
        for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal=signum):
                process = self.start()
                self.wait_marker(process, b'deployment_gateway_receiving=true\n')
                process.stdin.write(b'{')
                process.stdin.flush()
                process.send_signal(signum)
                code, stdout, _ = self.finish(process)
                self.assertEqual(code, 128 + signum)
                self.assertIn(b'deployment_gateway_cancelled=true', stdout)
                self.assert_no_release()

    def test_cancellation_after_child_start_waits_for_the_release_before_unlocking(self):
        for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal=signum):
                process, _ = self.start_held_release()
                process.send_signal(signum)
                with self.assertRaises(subprocess.TimeoutExpired):
                    process.wait(timeout=0.15)
                self.assert_lock_busy()
                code, stdout, _ = self.send(self.wire())
                self.assertNotEqual(code, 0)
                self.assertIn(b'deployment_gateway_busy=true', stdout)
                self.release_gate()
                code, stdout, stderr = self.finish(process)
                self.assertEqual(code, 128 + signum, stderr.decode())
                self.assertIn(b'deployment_gateway_cancelled=true', stdout)
                self.assertTrue((self.root / 'child_done').exists())
                self.assert_lock_free()
                self.assertFalse(list(self.gateway_root.glob('incoming-*')))

    def test_disconnected_stdout_does_not_interrupt_the_child(self):
        process, _ = self.start_held_release()
        process.stdout.close()
        process.stdout = None
        self.release_gate()
        code, _, stderr = self.finish(process)
        self.assertEqual(code, 0, stderr.decode())
        self.assertTrue((self.root / 'child_done').exists())
        self.assert_lock_free()

    def test_forwarding_error_waits_for_the_child_before_cleaning_incoming(self):
        process, state = self.start_held_release(mode='forward-fail')
        with self.assertRaises(subprocess.TimeoutExpired):
            process.wait(timeout=0.15)
        self.assertTrue(Path(state['incoming']).is_dir())
        self.assert_lock_busy()
        self.release_gate()
        code, stdout, stderr = self.finish(process)
        self.assertNotEqual(code, 0)
        self.assertIn(b'deployment_gateway_failed=true', stderr)
        self.assertNotIn(b'SENSITIVE_', stdout + stderr)
        self.assertTrue((self.root / 'child_done').exists())
        self.assertFalse(list(self.gateway_root.glob('incoming-*')))
        self.assert_lock_free()

    def test_sigkill_parent_leaves_child_output_and_lock_alive_until_completion(self):
        process, state = self.start_held_release()
        process.kill()
        code, _, _ = self.finish(process)
        self.assertEqual(code, -signal.SIGKILL)
        self.assert_lock_busy()
        log_path = Path(state['incoming']) / 'release.log'
        self.assertTrue(log_path.exists())
        self.release_gate()
        deadline = time.monotonic() + 5
        status = None
        while time.monotonic() < deadline:
            pid, current = os.waitpid(state['pid'], os.WNOHANG)
            if pid:
                status = current
                break
            time.sleep(0.02)
        self.assertIsNotNone(status, 'orphaned fixture release did not finish')
        self.assertEqual(os.waitstatus_to_exitcode(status), 0)
        self.assertTrue((self.root / 'child_done').exists())
        self.assertIn(b'deployed_commit=' + COMMIT.encode(), log_path.read_bytes())
        self.assert_lock_free()

    def test_child_nonzero_status_remains_failure_and_releases_the_lock(self):
        (self.root / 'mode').write_text('fail')
        code, stdout, stderr = self.send(self.wire())
        self.assertNotEqual(code, 0)
        self.assertIn(b'preservation_check_failed=true', stdout)
        self.assertIn(b'deployment_gateway_failed=true', stderr)
        self.assertNotIn(b'deployed_commit=', stdout)
        self.assertNotIn(b'SENSITIVE_', stdout + stderr)
        self.assert_lock_free()


if __name__ == '__main__':
    unittest.main()
