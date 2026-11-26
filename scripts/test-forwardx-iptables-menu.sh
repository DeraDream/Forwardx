#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/etc" "$T/bin" "$T/state" "$T/assets"
printf '%s\n' '{"panelUrl":"https://panel.example.com","token":"oldtoken","publicIpv4":"42.193.170.239"}' > "$T/etc/config.json"
printf '1.0.2\n' > "$T/state/version"
printf 'old agent\n' > "$T/agent"
printf '# ForwardX iptables-only management menu\n' > "$T/forwardx"
cat > "$T/bin/systemctl" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$T/bin/systemctl"
TEST_DIR="$T" ROOT="$ROOT" python3 - <<'PY'
import os
from pathlib import Path
root = Path(os.environ['ROOT']); t = Path(os.environ['TEST_DIR'])
s = (root/'scripts/forwardx-iptables-menu.sh').read_text()
# The real menu is root-only; the sandbox tests use private temporary paths
# and must also run under the unprivileged GitHub Actions user.
s = s.replace('[ "$(id -u)" -eq 0 ]', 'true')
for old, new in [
    ('/etc/forwardx/agent/config.json', str(t/'etc/config.json')),
    ('/etc/systemd/system/${SERVICE}.service.d/proxy.conf', str(t/'etc/proxy.conf')),
    ('/usr/local/bin/forwardx-agent-iptables-only', str(t/'agent')),
    ('/usr/local/bin/forwardx', str(t/'forwardx')),
    ('/var/lib/forwardx-agent/iptables-only-version', str(t/'state/version')),
    ('/root/forwardx-agent-downloads', str(t/'downloads')),
]: s = s.replace(old, new)
(t/'menu').write_text(s)
PY
printf '3\nnewtoken\n8\n' | PATH="$T/bin:$PATH" bash "$T/menu" > "$T/output"
python3 - "$T/etc/config.json" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))['token'] == 'newtoken'
PY
printf 'new agent\n' > "$T/assets/forwardx-agent"
printf '1.0.3\n' > "$T/assets/VERSION"
cp "$T/menu" "$T/assets/forwardx-menu"
tar -czf "$T/forwardx-agent-iptables-only-v1.0.3-linux-amd64.tar.gz" -C "$T/assets" forwardx-agent VERSION forwardx-menu
printf '1\n%s\n1\n\n\n\n\ny\n8\n' "$T" | PATH="$T/bin:$PATH" bash "$T/menu" > "$T/output"
grep -q 'new agent' "$T/agent"
grep -q '1.0.3' "$T/state/version"
python3 - "$T/etc/config.json" <<'PY'
import json,sys
c=json.load(open(sys.argv[1])); assert c['token']=='newtoken' and c['publicIpv4']=='42.193.170.239'
PY
cat > "$T/bin/systemctl" <<'EOF'
#!/bin/sh
if [ "$1" = restart ] && [ -f "$MOCK_FAIL_ONCE" ]; then
  rm -f "$MOCK_FAIL_ONCE"
  exit 1
fi
exit 0
EOF
chmod +x "$T/bin/systemctl"
touch "$T/failed-once"
printf '3\nbadtoken\n8\n' | MOCK_FAIL_ONCE="$T/failed-once" PATH="$T/bin:$PATH" bash "$T/menu" > "$T/output" 2>&1
python3 - "$T/etc/config.json" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))['token'] == 'newtoken', 'rollback lost the original token'
PY
# Mock GitHub releases separately from package downloads: the panel's latest
# release must not be mistaken for the newest standalone Agent.
mkdir -p "$T/remote" "$T/downloads"
printf 'online agent\n' > "$T/assets/forwardx-agent"
printf '1.0.4\n' > "$T/assets/VERSION"
tar -czf "$T/remote/forwardx-agent-iptables-only-v1.0.4-linux-amd64.tar.gz" -C "$T/assets" forwardx-agent VERSION forwardx-menu
(cd "$T/remote" && sha256sum forwardx-agent-iptables-only-v1.0.4-linux-amd64.tar.gz > iptables-only-v1.0.4-SHA256SUMS)
cat > "$T/bin/curl" <<'EOF'
#!/bin/bash
set -euo pipefail
out=''
while [ "$#" -gt 1 ]; do
  case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac
done
case "$1" in
  *'/releases?per_page=100&page=1')
    printf '%s\n' '[{"tag_name":"v9.9.9","draft":false,"prerelease":false,"assets":[]},{"tag_name":"iptables-only-v1.0.4","draft":false,"prerelease":false,"assets":[{"name":"forwardx-agent-iptables-only-v1.0.4-linux-amd64.tar.gz"},{"name":"iptables-only-v1.0.4-SHA256SUMS"}]}]' ;;
  *'/releases/download/iptables-only-v1.0.4/'*) cp "$MOCK_REMOTE/${1##*/}" "$out" ;;
  *) echo "unexpected curl request $1" >&2; exit 1 ;;
esac
EOF
chmod +x "$T/bin/curl"
printf '2\ny\n8\n' | MOCK_REMOTE="$T/remote" PATH="$T/bin:$PATH" bash "$T/menu" > "$T/output"
grep -q 'online agent' "$T/agent"
grep -q '^1.0.4$' "$T/state/version"
test -f "$T/downloads/forwardx-agent-iptables-only-v1.0.4-linux-amd64.tar.gz"
printf '2\n8\n' | MOCK_REMOTE="$T/remote" PATH="$T/bin:$PATH" bash "$T/menu" > "$T/output"
grep -q '已是最新或更高版本' "$T/output"
# A bad checksum must not replace the running binary or version.
printf '0%.0s' {1..64} > "$T/remote/iptables-only-v1.0.4-SHA256SUMS.bad"
printf '1.0.3\n' > "$T/state/version"
cp "$T/remote/iptables-only-v1.0.4-SHA256SUMS.bad" "$T/remote/iptables-only-v1.0.4-SHA256SUMS"
printf '  forwardx-agent-iptables-only-v1.0.4-linux-amd64.tar.gz\n' >> "$T/remote/iptables-only-v1.0.4-SHA256SUMS"
printf '2\ny\n8\n' | MOCK_REMOTE="$T/remote" PATH="$T/bin:$PATH" bash "$T/menu" > "$T/output" 2>&1
grep -q '安装包校验失败' "$T/output"
grep -q '^1.0.3$' "$T/state/version"
grep -q 'online agent' "$T/agent"
# Restart failure rolls the online upgrade back without changing credentials.
(cd "$T/remote" && sha256sum forwardx-agent-iptables-only-v1.0.4-linux-amd64.tar.gz > iptables-only-v1.0.4-SHA256SUMS)
touch "$T/failed-once"
printf '2\ny\n8\n' | MOCK_FAIL_ONCE="$T/failed-once" MOCK_REMOTE="$T/remote" PATH="$T/bin:$PATH" bash "$T/menu" > "$T/output" 2>&1
grep -q '^1.0.3$' "$T/state/version"
python3 - "$T/etc/config.json" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))['token'] == 'newtoken'
PY
echo 'menu configuration, local/online upgrade, checksum and rollback smoke tests passed'
