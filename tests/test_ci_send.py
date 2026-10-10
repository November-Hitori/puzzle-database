import hashlib
import io
import json
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


SENDER = Path(__file__).parents[1] / 'deploy' / 'ci-send.py'
VERIFIER = SENDER.with_name('release_archive.py')
COMMIT = 'a' * 40
FAKE_SSH = '''import json, os, pathlib, signal, sys
root = pathlib.Path(os.environ['CI_SEND_FIXTURE'])
(root / 'transport.json').write_text(json.dumps({'pid': os.getpid(), 'args': sys.argv[1:]}))
mode = os.environ.get('CI_SEND_FIXTURE_MODE', 'receive')
if mode == 'early-close':
    os.close(0)
    sys.exit(23)
if mode == 'hold-input':
    print('fixture_transport_ready=true', flush=True)
    signal.pause()
else:
    (root / 'received.bin').write_bytes(sys.stdin.buffer.read())
    print('fixture_eof_seen=true', flush=True)
    sys.exit(23 if mode == 'reject' else 0)
'''


class CiSendTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='puzarchive-sender-fixture-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        transport = self.root / 'ssh'
        transport.write_text('#!' + sys.executable + '\n' + FAKE_SSH)
        transport.chmod(0o755)
        self.config = self.root / 'isolated config'
        self.config.write_text('Only the isolated transport uses this fixture.\n')
        self.environment = {**os.environ, 'PATH': str(self.root) + os.pathsep + os.environ['PATH'],
                            'CI_SEND_FIXTURE': str(self.root)}

    def archive(self, corrupt=False):
        archive = self.root / 'release.tar'
        sources = {'server.mjs': b'fixture server', 'db.mjs': b'fixture database',
                   'docs/penpa.md': b'fixture guidelines', 'fixture.bin': bytes(range(256)) * 4096}
        hashes = {name: hashlib.sha256(body).hexdigest() for name, body in sources.items()}
        if corrupt:
            sources['server.mjs'] += b' changed after manifest'
        sources['.release.json'] = json.dumps({'commit': COMMIT, 'files': hashes}).encode()
        with tarfile.open(archive, 'w') as tar:
            for name, body in sources.items():
                member = tarfile.TarInfo(name)
                member.mode = 0o644
                member.size = len(body)
                tar.addfile(member, io.BytesIO(body))
            data = tarfile.TarInfo('data')
            data.type = tarfile.DIRTYPE
            data.mode = 0o755
            tar.addfile(data)
        return archive

    def send(self, archive, mode='receive'):
        return subprocess.run([sys.executable, str(SENDER), str(archive), str(self.config)],
                              env={**self.environment, 'CI_SEND_FIXTURE_MODE': mode},
                              capture_output=True, timeout=10)

    def assert_transport_stopped(self):
        pid = json.loads((self.root / 'transport.json').read_text())['pid']
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_binary_header_archive_and_eof_survive_the_compressed_ssh_command(self):
        archive = self.archive()
        result = self.send(archive)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        header, separator, payload = (self.root / 'received.bin').read_bytes().partition(b'\n')
        self.assertEqual(separator, b'\n')
        self.assertEqual(payload, archive.read_bytes())
        self.assertEqual(json.loads(header), {'commit': COMMIT, 'sha256': hashlib.sha256(payload).hexdigest()})
        received = self.root / 'received.tar'
        received.write_bytes(payload)
        verified = subprocess.run([sys.executable, str(VERIFIER), 'verify', str(received), COMMIT],
                                  capture_output=True, timeout=10)
        self.assertEqual(verified.returncode, 0, verified.stderr.decode())
        args = json.loads((self.root / 'transport.json').read_text())['args']
        self.assertEqual(args, ['-C', '-F', str(self.config), 'puzarchive-production'])
        self.assertIn(b'release_payload_bytes=' + str(len(payload)).encode(), result.stdout)
        self.assertIn(b'fixture_eof_seen=true', result.stdout)
        self.assertIn(b'local_stdin_closed=true', result.stdout)
        self.assertIn(b'ssh_exit_code=0', result.stdout)
        self.assertNotIn(header, result.stdout + result.stderr)
        self.assertNotIn(str(self.config).encode(), result.stdout + result.stderr)
        self.assert_transport_stopped()

    def test_invalid_archive_never_starts_the_transport(self):
        result = self.send(self.archive(corrupt=True))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'transport.json').exists())
        self.assertNotIn(b'release_transfer_started=true', result.stdout)
        self.assertNotIn(b'local_stdin_closed=true', result.stdout)

    def test_remote_nonzero_status_stays_a_failure_after_eof(self):
        result = self.send(self.archive(), 'reject')
        self.assertEqual(result.returncode, 23)
        self.assertIn(b'fixture_eof_seen=true', result.stdout)
        self.assertIn(b'local_stdin_closed=true', result.stdout)
        self.assertIn(b'ssh_exit_code=23', result.stdout)
        self.assertNotIn(b'success=true', result.stdout + result.stderr)
        self.assert_transport_stopped()

    def test_early_closed_pipe_fails_without_local_completion(self):
        result = self.send(self.archive(), 'early-close')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(b'local_stdin_closed=true', result.stdout)
        self.assertNotIn(b'success=true', result.stdout + result.stderr)
        self.assertIn(b'ssh_exit_code=', result.stdout)
        self.assert_transport_stopped()

    def assert_cancellation_reaps_transport(self, cancellation_signal, expected_exit_code):
        process = subprocess.Popen([sys.executable, str(SENDER), str(self.archive()), str(self.config)],
                                   env={**self.environment, 'CI_SEND_FIXTURE_MODE': 'hold-input'},
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        prefix = b''
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            deadline = time.monotonic() + 10
            while b'fixture_transport_ready=true\n' not in prefix:
                self.assertTrue(selector.select(max(0, deadline - time.monotonic())), 'transport did not become ready')
                chunk = os.read(process.stdout.fileno(), 4096)
                self.assertTrue(chunk, 'sender exited before transport was ready')
                prefix += chunk
        process.send_signal(cancellation_signal)
        stdout, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, expected_exit_code, stderr.decode())
        self.assertNotIn(b'local_stdin_closed=true', prefix + stdout)
        self.assertNotIn(b'success=true', prefix + stdout + stderr)
        self.assertIn(b'ssh_exit_code=', prefix + stdout)
        self.assert_transport_stopped()

    def test_interrupt_while_writing_reaps_the_transport(self):
        self.assert_cancellation_reaps_transport(signal.SIGINT, 130)

    def test_termination_while_writing_reaps_the_transport(self):
        self.assert_cancellation_reaps_transport(signal.SIGTERM, 143)


if __name__ == '__main__':
    unittest.main()
