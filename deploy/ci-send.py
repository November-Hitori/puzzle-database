"""Send a verified release to the forced SSH deployment command."""
import hashlib
import json
import pathlib
import signal
import subprocess
import sys
from release_archive import validate_archive


def cancel_transfer(signum, _frame):
    sys.exit(128 + signum)


signal.signal(signal.SIGTERM, cancel_transfer)

try:
    archive = pathlib.Path(sys.argv[1])
    metadata = validate_archive(archive)
    payload = archive.read_bytes()
    header = json.dumps({'commit': metadata['commit'], 'sha256': hashlib.sha256(payload).hexdigest()}).encode() + b'\n'
    process = subprocess.Popen(['ssh', '-C', '-F', sys.argv[2], 'puzarchive-production'], stdin=subprocess.PIPE)
except Exception:
    sys.exit('release_sender_exit_code=1')

sender_exit_code = 0
try:
    print('release_transfer_started=true', flush=True)
    print('release_payload_bytes=' + str(len(payload)), flush=True)
    process.stdin.write(header)
    process.stdin.write(payload)
    process.stdin.close()
    # This is local SSH input completion, not confirmation from the remote host.
    print('local_stdin_closed=true', flush=True)
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
    print('ssh_exit_code=' + str(process.returncode), flush=True)

sys.exit(sender_exit_code or (process.returncode if process.returncode >= 0 else 1))
