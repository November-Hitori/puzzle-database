"""Deterministic, source-only releases; reject private state and unsafe archives."""
import hashlib
import io
import json
import pathlib
import re
import subprocess
import sys
import tarfile

METADATA = '.release.json'
MAX_BYTES = 32 * 1024 * 1024


def safe_name(name):
    parts = pathlib.PurePosixPath(name).parts
    return (bool(parts) and not name.startswith('/') and '..' not in parts
            and not any(p in {'.git', 'node_modules', '.env', 'trusted-users.json'} for p in parts)
            and not any(p.startswith('.env.') and p != '.env.example' for p in parts)
            and not any(p.endswith(('.sqlite', '.sqlite-wal', '.sqlite-shm', '.xlsx', '.pem', '.key')) for p in parts)
            and (parts[0] != 'data' or name.rstrip('/') == 'data'))


def validate_archive(archive, commit=None):
    with tarfile.open(archive, 'r:') as tar:
        members = tar.getmembers()
        if len(members) > 1000 or len({m.name for m in members}) != len(members):
            raise ValueError('duplicate or excessive release members')
        if sum(m.size for m in members) > MAX_BYTES:
            raise ValueError('release exceeds source size limit')
        for member in members:
            if not safe_name(member.name) or not (member.isfile() or member.isdir()):
                raise ValueError('unsafe release member')
            if member.uid != 0 or member.gid != 0 or member.mode != (0o755 if member.isdir() else 0o644):
                raise ValueError('invalid release ownership or mode')
        meta = json.load(tar.extractfile(METADATA))
        if not re.fullmatch(r'[0-9a-f]{40}', meta['commit']) or (commit and meta['commit'] != commit):
            raise ValueError('release commit mismatch')
        files = {m.name: hashlib.sha256(tar.extractfile(m).read()).hexdigest()
                 for m in members if m.isfile() and m.name != METADATA}
        if files != meta['files']:
            raise ValueError('release source manifest mismatch')
        data = tar.getmember('data')
        if not data.isdir() or not all(n in files for n in ['server.mjs', 'db.mjs', 'docs/penpa.md']):
            raise ValueError('release runtime files missing')
        return meta


def package(output):
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    if subprocess.check_output(['git', 'status', '--porcelain']):
        raise ValueError('candidate working tree must be clean')
    epoch = int(subprocess.check_output(['git', 'show', '-s', '--format=%ct', 'HEAD']))
    files = {}
    source = subprocess.check_output(['git', 'archive', '--format=tar', commit])
    with tarfile.open(fileobj=io.BytesIO(source)) as tar, tarfile.open(output, 'w', format=tarfile.USTAR_FORMAT) as target:
        for member in tar.getmembers():
            if not safe_name(member.name) or not (member.isfile() or member.isdir()):
                raise ValueError('private or unsupported tracked file')
            member.uid = member.gid = 0
            member.uname = member.gname = 'root'
            member.mode = 0o755 if member.isdir() else 0o644
            member.mtime = epoch
            member.pax_headers = {}
            content = tar.extractfile(member).read() if member.isfile() else None
            if content is not None:
                files[member.name] = hashlib.sha256(content).hexdigest()
            target.addfile(member, io.BytesIO(content) if content is not None else None)
        data = tarfile.TarInfo('data')
        data.type = tarfile.DIRTYPE
        data.uid = data.gid = 0
        data.uname = data.gname = 'root'
        data.mode = 0o755
        data.mtime = epoch
        target.addfile(data)
        content = json.dumps({'commit': commit, 'files': files}, sort_keys=True).encode()
        metadata = tarfile.TarInfo(METADATA)
        metadata.uid = metadata.gid = 0
        metadata.uname = metadata.gname = 'root'
        metadata.mode = 0o644
        metadata.mtime = epoch
        metadata.size = len(content)
        target.addfile(metadata, io.BytesIO(content))
    validate_archive(output, commit)
    print('release_commit=' + commit)
    print('release_files=' + str(len(files)))
    print('release_sha256=' + hashlib.sha256(pathlib.Path(output).read_bytes()).hexdigest())


if __name__ == '__main__':
    if sys.argv[1] == 'pack':
        package(sys.argv[2])
    elif sys.argv[1] == 'verify':
        meta = validate_archive(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
        print('release_verified=true')
    elif sys.argv[1] == 'extract':
        validate_archive(sys.argv[2], sys.argv[4])
        with tarfile.open(sys.argv[2]) as tar:
            tar.extractall(sys.argv[3])
    else:
        raise ValueError('unknown release command')
