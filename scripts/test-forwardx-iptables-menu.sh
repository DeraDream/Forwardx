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
]: s = s.replace(old, new)
(t/'menu').write_text(s)
PY
printf '2\nnewtoken\n7\n' | PATH="$T/bin:$PATH" bash "$T/menu" > "$T/output"
python3 - "$T/etc/config.json" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))['token'] == 'newtoken'
PY
printf 'new agent\n' > "$T/assets/forwardx-agent"
printf '1.0.3\n' > "$T/assets/VERSION"
cp "$T/menu" "$T/assets/forwardx-menu"
tar -czf "$T/forwardx-agent-iptables-only-v1.0.3-linux-amd64.tar.gz" -C "$T/assets" forwardx-agent VERSION forwardx-menu
printf '1\n%s\n1\n\n\n\n\ny\n7\n' "$T" | PATH="$T/bin:$PATH" bash "$T/menu" > "$T/output"
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
printf '2\nbadtoken\n7\n' | MOCK_FAIL_ONCE="$T/failed-once" PATH="$T/bin:$PATH" bash "$T/menu" > "$T/output" 2>&1
python3 - "$T/etc/config.json" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))['token'] == 'newtoken', 'rollback lost the original token'
PY
echo 'menu configuration, local upgrade and rollback smoke tests passed'
