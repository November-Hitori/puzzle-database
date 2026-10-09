#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" = 0
source_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
public_key_file="$1"
test ! -L /home/ubuntu/.ssh/authorized_keys
test ! -L /usr/local/lib/puzarchive-deploy
install -d -o root -g root -m 0755 /usr/local/lib/puzarchive-deploy
for file in ci-gateway.py release_archive.py remote-release.sh preservation-check.mjs; do
  install -o root -g root -m 0644 "$source_dir/$file" "/usr/local/lib/puzarchive-deploy/$file"
done
cat > /usr/local/sbin/puzarchive-ci-deploy <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
exec /usr/bin/python3 /usr/local/lib/puzarchive-deploy/ci-gateway.py
WRAPPER
chown root:root /usr/local/sbin/puzarchive-ci-deploy
chmod 0755 /usr/local/sbin/puzarchive-ci-deploy
install -d -o root -g root -m 0700 /var/lib/puzarchive-deploy
python3 - "$public_key_file" <<'PYTHON'
import pathlib,re,os,pwd
key=pathlib.Path(__import__('sys').argv[1]).read_text().strip()
if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]+)?',key):
    raise ValueError('expected a dedicated Ed25519 deployment public key')
target=pathlib.Path('/home/ubuntu/.ssh/authorized_keys')
line='restrict,command="sudo -n /usr/local/sbin/puzarchive-ci-deploy" '+key
old=target.read_text()
if line not in old.splitlines():
    with target.open('a') as f:
        if old and not old.endswith('\n'): f.write('\n')
        f.write(line+'\n')
user=pwd.getpwnam('ubuntu');os.chown(target,user.pw_uid,user.pw_gid);os.chmod(target,0o600)
print('restricted_ci_deployment_key_installed=true')
PYTHON
