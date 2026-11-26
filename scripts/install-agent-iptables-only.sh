#!/usr/bin/env bash
# Offline installer for the Agent + system-provided iptables only.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo '请以 root 运行' >&2; exit 1; fi
if ! command -v iptables >/dev/null 2>&1; then
  echo '缺少系统 iptables：请先用发行版包管理器安装（此包不包含内核工具）' >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
  echo '此离线包目前仅支持 systemd 系统' >&2; exit 1
fi
SERVICE=forwardx-agent-iptables-only
PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$PACKAGE_DIR/forwardx-agent"
MENU_SCRIPT="$PACKAGE_DIR/forwardx-menu"
if systemctl is-active --quiet forwardx-agent || systemctl is-enabled --quiet forwardx-agent; then
  echo '检测到标准 forwardx-agent 正在运行或设置为开机启动：请先停用标准 Agent，避免两个 Agent 共用状态文件' >&2; exit 1
fi
if [ ! -f "$BIN" ]; then echo "找不到 $BIN" >&2; exit 1; fi
if [ -L "$BIN" ] || [ ! -f "$MENU_SCRIPT" ] || [ -L "$MENU_SCRIPT" ]; then
  echo '安装包缺少菜单脚本，或包含符号链接；请使用新版轻量包' >&2; exit 1
fi
if [ -e /usr/local/bin/forwardx ] && ! grep -qF '# ForwardX iptables-only management menu' /usr/local/bin/forwardx; then
  echo '/usr/local/bin/forwardx 已被其他程序占用，拒绝覆盖' >&2; exit 1
fi
command -v python3 >/dev/null || { echo '轻量版菜单需要 python3，请先安装' >&2; exit 1; }
CONFIG=/etc/forwardx/agent/config.json
PROXY_DROPIN=/etc/systemd/system/${SERVICE}.service.d/proxy.conf

# Validate each answer before asking the next question. An empty proxy means direct access.
valid_address_chars() {
  local LC_ALL=C
  [[ "$1" =~ ^[!-~]+$ && "$1" != *'"'* && "$1" != *'\'* ]]
}
validate_proxy() {
  [ -z "$1" ] && return 0
  case "$1" in http://?*) ;; *) echo '代理地址必须以 http:// 开头并包含主机名（直连请留空）' >&2; return 1 ;; esac
  valid_address_chars "$1" || { echo '代理地址不能包含空格、控制字符、引号或反斜杠' >&2; return 1; }
}
validate_panel() {
  case "$1" in http://?*|https://?*) ;; *) echo '真实面板地址必须是非空的 http(s) URL' >&2; return 1 ;; esac
  valid_address_chars "$1" || { echo '真实面板地址不能包含空格、控制字符、引号或反斜杠' >&2; return 1; }
}
validate_token() {
  [[ "$1" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'Agent Token 无效（仅接受字母、数字、下划线和连字符）' >&2; return 1; }
}
validate_public_ipv4() {
  [ -z "$1" ] || [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo '本机公网 IPv4 格式不正确' >&2; return 1; }
}
# Environment-provided values are checked once; interactive answers can be retried.
prompt_and_validate() {
  local name="$1" label="$2" validator="$3" value="${!1}"
  if [ -n "$value" ] || [ ! -t 0 ]; then
    "$validator" "$value"
    return
  fi
  while true; do
    if [ "$name" = token ]; then
      IFS= read -r -s -p "$label" value || { echo '输入已中断' >&2; return 1; }
      echo >&2
    else
      IFS= read -r -p "$label" value || { echo '输入已中断' >&2; return 1; }
    fi
    if "$validator" "$value"; then
      printf -v "$name" '%s' "$value"
      return 0
    fi
  done
}

if [ ! -f "$CONFIG" ]; then
  # Prompt only on first install. Environment variables also allow unattended use.
  proxy_url="${FORWARDX_AGENT_PROXY_URL:-}"
  panel_url="${FORWARDX_PANEL_URL:-}"
  token="${FORWARDX_AGENT_TOKEN:-}"
  public_ipv4="${FORWARDX_AGENT_PUBLIC_IPV4:-}"
  prompt_and_validate proxy_url '代理地址（如 http://中转机IP:5555，直连请留空）: ' validate_proxy
  prompt_and_validate panel_url '真实面板地址（如 https://panel.example.com）: ' validate_panel
  prompt_and_validate token 'Agent Token（输入不显示）: ' validate_token
  prompt_and_validate public_ipv4 '本机公网 IPv4（不能直连公网 IP 检测服务时填写，直连请留空）: ' validate_public_ipv4
  install -d -m 0700 /etc/forwardx/agent
  (umask 077; printf '{"panelUrl":"%s","token":"%s","interval":30,"publicIpv4":"%s"}\n' "${panel_url%/}" "$token" "$public_ipv4" > "$CONFIG")
  if [ -n "$proxy_url" ]; then
    install -d -m 0755 "/etc/systemd/system/${SERVICE}.service.d"
    printf '[Service]\nEnvironment="HTTP_PROXY=%s"\nEnvironment="HTTPS_PROXY=%s"\n' "$proxy_url" "$proxy_url" > "$PROXY_DROPIN"
  fi
  unset token
fi
install -m 0755 "$BIN" /usr/local/bin/forwardx-agent-iptables-only
install -m 0755 "$MENU_SCRIPT" /usr/local/bin/forwardx
# DNAT forwarding requires kernel IP forwarding as well as iptables userspace.
printf 'net.ipv4.ip_forward=1\n' > /etc/sysctl.d/90-forwardx-agent-iptables.conf
sysctl -w net.ipv4.ip_forward=1 >/dev/null
install -d -m 0755 /var/log/forwardx-agent /var/lib/forwardx-agent
if [ -f "$PACKAGE_DIR/VERSION" ]; then
  install -m 0644 "$PACKAGE_DIR/VERSION" /var/lib/forwardx-agent/iptables-only-version
fi
cat > "/etc/systemd/system/${SERVICE}.service" <<'EOF'
[Unit]
Description=ForwardX Agent (iptables-only installation)
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/forwardx-agent-iptables-only -config /etc/forwardx/agent/config.json
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now "$SERVICE"
systemctl restart "$SERVICE"
echo 'Agent 已安装。请在面板只分配 iptables 转发规则；其他运行时未安装。'
if [ -t 0 ]; then /usr/local/bin/forwardx; fi
