#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
# Exercise the real installer validators without installing a service or requiring root.
awk '/^# Validate each answer/{copy=1} /^if \[ ! -f "\$CONFIG"/{copy=0} copy' \
  "$ROOT/scripts/install-agent-iptables-only.sh" > "$T/inputs.sh"
bash -n "$ROOT/scripts/install-agent-iptables-only.sh"
bash -c '
  set -euo pipefail
  source "$1"
  validate_proxy ""
  validate_proxy "http://proxy.example.com:5555"
  ! validate_proxy "http://proxy.example.com:5555 "
  ! validate_proxy "https://proxy.example.com"
  validate_panel "https://panel.example.com"
  ! validate_panel "https://panel.example.com "
  ! validate_panel ""
  ! validate_panel $'"'"'https://panel.example.com\ninvalid'"'"'
  ! validate_token ""
  validate_token "abc_123-XYZ"
  ! validate_token "invalid token"
  validate_public_ipv4 ""
  validate_public_ipv4 "42.193.170.239"
  ! validate_public_ipv4 "not-an-ip"
  proxy_url=""; panel_url="https://panel.example.com"; token="abc_123-XYZ"
  prompt_and_validate proxy_url "proxy: " validate_proxy
  prompt_and_validate panel_url "panel: " validate_panel
  prompt_and_validate token "token: " validate_token
  [ -z "$proxy_url" ]
' _ "$T/inputs.sh" 2> "$T/noninteractive-errors"
python3 - "$T/inputs.sh" <<'PY'
import os, pty, select, sys, time
path = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    os.execlp('bash', 'bash', '-c', '''
        set -euo pipefail
        source "$1"
        proxy_url=""; panel_url=""; token=""
        prompt_and_validate proxy_url 'proxy: ' validate_proxy
        prompt_and_validate panel_url 'panel: ' validate_panel
        prompt_and_validate token 'token: ' validate_token
        printf 'RESULT:%s|%s|%s\n' "$proxy_url" "$panel_url" "${#token}"
    ''', '_', path)
output = b''
def wait_for(marker, count=1):
    global output
    deadline = time.monotonic() + 5
    while output.count(marker) < count and time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                output += os.read(fd, 4096)
            except OSError:
                break
    assert output.count(marker) >= count, output.decode(errors='replace')

wait_for(b'proxy: ')
os.write(fd, b'\n')
wait_for(b'panel: ')
os.write(fd, b'https://panel.example.com \n')
wait_for(b'panel: ', 2)
os.write(fd, b'https://panel.example.com\n')
wait_for(b'token: ')
os.write(fd, b'bad token\n')
wait_for(b'token: ', 2)
os.write(fd, b'good_token\n')
wait_for(b'RESULT:')
_, status = os.waitpid(pid, 0)
text = output.decode(errors='replace')
assert os.waitstatus_to_exitcode(status) == 0, text
assert 'RESULT:|https://panel.example.com|10' in text, text
assert '真实面板地址不能包含' in text and 'Agent Token 无效' in text, text
assert 'good_token' not in text, 'Token was echoed'
PY
echo 'iptables-only installer input validation tests passed'
