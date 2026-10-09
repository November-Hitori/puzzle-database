import hashlib
import importlib.util
import io
import json
import pathlib
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('release_archive', pathlib.Path(__file__).parents[1] / 'deploy' / 'release_archive.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseArchiveTests(unittest.TestCase):
    def fixture(self, directory, extra=None, corrupt=False):
        output = pathlib.Path(directory, 'release.tar')
        sources = {'server.mjs': b'fixture server', 'db.mjs': b'fixture DB', 'docs/penpa.md': b'fixture spec'}
        hashes = {name: hashlib.sha256(body).hexdigest() for name, body in sources.items()}
        metadata = json.dumps({'commit': 'a' * 40, 'files': hashes}).encode()
        if corrupt:
            sources['server.mjs'] = b'changed after manifest'
        with tarfile.open(output, 'w') as tar:
            for name, body in {**sources, release.METADATA: metadata}.items():
                member = tarfile.TarInfo(name)
                member.mode = 0o644
                member.size = len(body)
                tar.addfile(member, io.BytesIO(body))
            member = tarfile.TarInfo('data')
            member.type = tarfile.DIRTYPE
            member.mode = 0o755
            tar.addfile(member)
            if extra:
                tar.addfile(extra)
        return output

    def test_correct_manifest_and_empty_data(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(release.validate_archive(self.fixture(directory), 'a' * 40)['commit'], 'a' * 40)

    def test_rejects_commit_and_content_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                release.validate_archive(self.fixture(directory), 'b' * 40)
            with self.assertRaises(ValueError):
                release.validate_archive(self.fixture(directory, corrupt=True))

    def test_rejects_traversal_private_files_links_and_duplicates(self):
        for name in ['../outside', '/outside', '.env', '.env.local', 'data/real.sqlite', 'data/trusted-users.json', 'server.mjs']:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                member = tarfile.TarInfo(name)
                member.mode = 0o644
                with self.assertRaises(ValueError):
                    release.validate_archive(self.fixture(directory, member))
        with tempfile.TemporaryDirectory() as directory:
            member = tarfile.TarInfo('link')
            member.type = tarfile.SYMTYPE
            member.linkname = '/var/lib/puzarchive'
            member.mode = 0o644
            with self.assertRaises(ValueError):
                release.validate_archive(self.fixture(directory, member))

    def test_rejects_wrong_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            member = tarfile.TarInfo('unowned')
            member.mode = 0o644
            member.uid = 1000
            with self.assertRaises(ValueError):
                release.validate_archive(self.fixture(directory, member))


if __name__ == '__main__':
    unittest.main()
