#!/usr/bin/env bash
# ForwardX iptables-only management menu. Runs locally; never downloads assets.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo '请以 root 运行 forwardx' >&2; exit 1; }
SERVICE=forwardx-agent-iptables-only
CONFIG=/etc/forwardx/agent/config.json
PROXY_FILE=/etc/systemd/system/${SERVICE}.service.d/proxy.conf
BIN=/usr/local/bin/forwardx-agent-iptables-only
MENU=/usr/local/bin/forwardx
VERSION_FILE=/var/lib/forwardx-agent/iptables-only-version
[ -f "$CONFIG" ] || { echo "配置不存在：$CONFIG，请先运行安装包中的 install.sh" >&2; exit 1; }
command -v python3 >/dev/null || { echo '菜单需要 python3 读写现有配置' >&2; exit 1; }

load_settings() {
  mapfile -t settings < <(python3 - "$CONFIG" "$PROXY_FILE" <<'PY'
import json, re, sys
with open(sys.argv[1]) as f:
    c = json.load(f)
p = ''
try:
    with open(sys.argv[2]) as f:
        match = re.search(r'^Environment="HTTPS_PROXY=([^"\n]+)"$', f.read(), re.M)
        if match: p = match.group(1)
except FileNotFoundError:
    pass
for v in (p, c.get('panelUrl', ''), c.get('token', ''), c.get('publicIpv4', '')):
    print(str(v))
PY
  )
  proxy="${settings[0]:-}" panel="${settings[1]:-}" token="${settings[2]:-}" ip="${settings[3]:-}"
}

# Validate everything before changing disk state; preserve other config fields.
save_settings() {
  MENU_PROXY="$proxy" MENU_PANEL="$panel" MENU_TOKEN="$token" MENU_IP="$ip" \
  python3 - "$CONFIG" "$PROXY_FILE" <<'PY'
import ipaddress, json, os, re, sys, tempfile
from urllib.parse import urlsplit
config_path, proxy_path = sys.argv[1:]
p, panel, token, ip = (os.environ['MENU_'+name] for name in ('PROXY', 'PANEL', 'TOKEN', 'IP'))
for label, value, schemes in (('代理地址', p, ('http',)), ('面板地址', panel, ('http', 'https'))):
    if not value:
        if label == '面板地址': raise SystemExit('面板地址不能为空')
        continue
    u = urlsplit(value)
    if u.scheme not in schemes or not u.hostname or u.username or u.password or u.query or u.fragment or any(ch.isspace() for ch in value):
        raise SystemExit(label + '无效')
    if label == '代理地址' and (u.path not in ('', '/') or any(ch in value for ch in ('"', '\\', '\r', '\n')) or not u.port):
        raise SystemExit('代理地址必须是 http://主机:端口')
if not re.fullmatch(r'[A-Za-z0-9_-]+', token): raise SystemExit('Token 无效')
if ip:
    try:
        addr = ipaddress.IPv4Address(ip)
        if not addr.is_global: raise ValueError()
    except ValueError:
        raise SystemExit('本机公网 IPv4 无效')
with open(config_path) as f: c = json.load(f)
c.update(panelUrl=panel.rstrip('/'), token=token, publicIpv4=ip)
def atomic_write(path, value, mode):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=os.path.dirname(path))
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'w') as f: f.write(value)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp): os.unlink(temp)
atomic_write(config_path, json.dumps(c, ensure_ascii=False)+'\n', 0o600)
if p:
    atomic_write(proxy_path, '[Service]\nEnvironment="HTTP_PROXY='+p+'"\nEnvironment="HTTPS_PROXY='+p+'"\n', 0o600)
else:
    # Clear existing systemd proxy settings when switching to direct access.
    atomic_write(proxy_path, '[Service]\nEnvironment="HTTP_PROXY=" "HTTPS_PROXY=" "http_proxy=" "https_proxy="\n', 0o600)
PY
}

backup_state() {
  tmp="$(mktemp -d)"
  cp -p "$CONFIG" "$tmp/config"
  if [ -f "$PROXY_FILE" ]; then cp -p "$PROXY_FILE" "$tmp/proxy"; fi
  if [ -f "$BIN" ]; then cp -p "$BIN" "$tmp/agent"; fi
  if [ -f "$MENU" ]; then cp -p "$MENU" "$tmp/menu"; fi
  if [ -f "$VERSION_FILE" ]; then cp -p "$VERSION_FILE" "$tmp/version"; fi
}
restore_state() {
  cp -p "$tmp/config" "$CONFIG"
  if [ -f "$tmp/proxy" ]; then cp -p "$tmp/proxy" "$PROXY_FILE"; else rm -f "$PROXY_FILE"; fi
  if [ -f "$tmp/agent" ]; then cp -p "$tmp/agent" "$BIN"; fi
  if [ -f "$tmp/menu" ]; then cp -p "$tmp/menu" "$MENU"; fi
  if [ -f "$tmp/version" ]; then cp -p "$tmp/version" "$VERSION_FILE"; fi
  systemctl daemon-reload
  systemctl restart "$SERVICE" || true
}
restart_or_rollback() {
  systemctl daemon-reload
  if systemctl restart "$SERVICE" && sleep 2 && systemctl is-active --quiet "$SERVICE"; then
    echo '配置已保存，服务运行中'
    rm -rf "$tmp"
  else
    echo '服务启动失败，正在恢复旧版本/配置' >&2
    restore_state
    rm -rf "$tmp"
    return 1
  fi
}
ask_settings() {
  local value
  printf '直接回车保留当前值；代理/IP 输入 - 可清空。Token 会按要求显示原值，请确保终端无人旁观。\n'
  read -r -p "代理地址 [$proxy]: " value; [ -z "$value" ] || proxy="$value"
  [ "$value" != '-' ] || proxy=''
  read -r -p "面板地址 [$panel]: " value; [ -z "$value" ] || panel="$value"
  read -r -p "Agent Token [$token]: " value; [ -z "$value" ] || token="$value"
  read -r -p "本机公网 IPv4 [$ip]: " value; [ -z "$value" ] || ip="$value"
  [ "$value" != '-' ] || ip=''
}
change_one() {
  local value label="$1"
  load_settings
  case "$label" in
    token) read -r -p "Agent Token [$token]: " value; [ -z "$value" ] && return 0; token="$value" ;;
    proxy) read -r -p "代理地址 [$proxy]（输入 - 清空）: " value; [ -z "$value" ] && return 0; proxy="$value"; [ "$value" != '-' ] || proxy='' ;;
    panel) read -r -p "面板地址 [$panel]: " value; [ -z "$value" ] && return 0; panel="$value" ;;
    ip) read -r -p "本机公网 IPv4 [$ip]（输入 - 清空）: " value; [ -z "$value" ] && return 0; ip="$value"; [ "$value" != '-' ] || ip='' ;;
  esac
  backup_state
  if ! save_settings; then restore_state; rm -rf "$tmp"; return 1; fi
  restart_or_rollback
}
upgrade_local() {
  local directory arch package i choice version
  load_settings
  read -r -p '升级包所在目录 [/root]: ' directory
  directory="${directory:-/root}"
  [ -d "$directory" ] || { echo "目录不存在: $directory" >&2; return 1; }
  case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; *) echo '不支持的架构' >&2; return 1 ;; esac
  mapfile -t packages < <(find "$directory" -maxdepth 1 -type f -name "forwardx-agent-iptables-only-v*-linux-$arch.tar.gz" | sort -V)
  [ "${#packages[@]}" -gt 0 ] || { echo '目录内没有匹配本机架构的轻量包' >&2; return 1; }
  echo '请选择本地升级包：'
  for i in "${!packages[@]}"; do printf '%d. %s\n' "$((i+1))" "${packages[i]}"; done
  read -r -p '序号（回车取消）: ' choice
  [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#packages[@]}" ] || { echo '已取消'; return 0; }
  package="${packages[choice-1]}"
  version="${package##*/}"; version="${version#forwardx-agent-iptables-only-v}"; version="${version%-linux-$arch.tar.gz}"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo '升级包版本格式不正确' >&2; return 1; }
  tmp="$(mktemp -d)"
  if ! tar -xzf "$package" -C "$tmp" --no-same-owner --no-same-permissions forwardx-agent VERSION forwardx-menu ||
     [ -L "$tmp/forwardx-agent" ] || [ ! -f "$tmp/forwardx-agent" ] || [ -L "$tmp/forwardx-menu" ] ||
     [ "$(tr -d '\r\n' < "$tmp/VERSION" 2>/dev/null)" != "$version" ]; then
    echo '包损坏、架构不符或版本不匹配' >&2; rm -rf "$tmp"; return 1
  fi
  rm -rf "$tmp"
  echo "将从 v$(cat "$VERSION_FILE" 2>/dev/null || echo 未知) 升级到 v$version。"
  ask_settings
  read -r -p '确认升级？[y/N]: ' choice
  [[ "$choice" =~ ^[yY]$ ]] || { echo '已取消'; return 0; }
  backup_state
  # Extract only known filenames to a private directory and replace atomically.
  tar -xzf "$package" -C "$tmp" --no-same-owner --no-same-permissions forwardx-agent VERSION forwardx-menu
  if ! save_settings; then restore_state; rm -rf "$tmp"; return 1; fi
  install -m 0755 "$tmp/forwardx-agent" "$BIN.new"
  mv -f "$BIN.new" "$BIN"
  install -m 0755 "$tmp/forwardx-menu" "$MENU.new"
  mv -f "$MENU.new" "$MENU"
  restart_or_rollback || return 1
  printf '%s\n' "$version" > "$VERSION_FILE"
  echo "当前轻量版：v$version"
}

while true; do
  echo
  echo '==== ForwardX 轻量 Agent ===='
  echo '1. 从本地目录升级版本（默认 /root）'
  echo '2. 修改 Token'
  echo '3. 修改代理地址'
  echo '4. 修改面板地址'
  echo '5. 修改本机公网 IP'
  echo '6. 查看服务状态'
  echo '7. 退出脚本'
  read -r -p '请选择: ' choice || exit 0
  case "$choice" in
    1) upgrade_local || echo '升级失败，旧版本/配置已保留' >&2 ;;
    2) change_one token || echo '修改失败' >&2 ;;
    3) change_one proxy || echo '修改失败' >&2 ;;
    4) change_one panel || echo '修改失败' >&2 ;;
    5) change_one ip || echo '修改失败' >&2 ;;
    6) echo "轻量版：v$(cat "$VERSION_FILE" 2>/dev/null || echo 未知)"; systemctl status "$SERVICE" --no-pager || true ;;
    7) exit 0 ;;
    *) echo '无效选项' ;;
  esac
done
