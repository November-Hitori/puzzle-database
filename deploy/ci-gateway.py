#!/usr/bin/env python3
"""Forced SSH command. Accept a bounded release, then use root-owned deploy tools."""
import fcntl
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
from release_archive import MAX_BYTES, validate_archive


def main():
    if os.getuid() != 0:
        raise ValueError('gateway must run as root')
    root = pathlib.Path('/var/lib/puzarchive-deploy')
    root.mkdir(mode=0o700, exist_ok=True)
    lock = (root / 'deploy.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX)
    header = sys.stdin.buffer.readline(4097)
    if len(header) > 4096 or not header.endswith(b'\n'):
        raise ValueError('invalid release header')
    request = json.loads(header)
    commit, checksum = request['commit'], request['sha256']
    if not re.fullmatch(r'[0-9a-f]{40}', commit) or not re.fullmatch(r'[0-9a-f]{64}', checksum):
        raise ValueError('invalid release identity')
    with tempfile.TemporaryDirectory(prefix='incoming-', dir=root) as incoming:
        archive = pathlib.Path(incoming, 'release.tar')
        digest, size = hashlib.sha256(), 0
        with archive.open('xb') as output:
            while block := sys.stdin.buffer.read(65536):
                size += len(block)
                if size > MAX_BYTES:
                    raise ValueError('release too large')
                digest.update(block)
                output.write(block)
        if digest.hexdigest() != checksum:
            raise ValueError('release checksum mismatch')
        validate_archive(archive, commit)
        subprocess.run(['/bin/bash', '/usr/local/lib/puzarchive-deploy/remote-release.sh', incoming, commit, checksum], check=True)


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except Exception:
        # Do not serialize request bodies, credentials, or private database values.
        print('deployment_gateway_failed=true', file=sys.stderr)
        sys.exit(1)
