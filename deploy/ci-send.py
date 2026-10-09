"""Send a verified release to the forced SSH deployment command."""
import hashlib
import json
import pathlib
import subprocess
import sys
from release_archive import validate_archive

archive = pathlib.Path(sys.argv[1])
metadata = validate_archive(archive)
payload = archive.read_bytes()
header = json.dumps({'commit': metadata['commit'], 'sha256': hashlib.sha256(payload).hexdigest()}).encode() + b'\n'
subprocess.run(['ssh', '-F', sys.argv[2], 'puzarchive-production'], input=header + payload, check=True)
