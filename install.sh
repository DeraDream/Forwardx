#!/bin/bash
set -euo pipefail

REPO="DeraDream/sublinkX"
INSTALL_DIR="/usr/local/bin/sublink"
SERVICE_FILE="/etc/systemd/system/sublink.service"

if [ "$(id -u)" != "0" ]; then
    echo "该脚本必须以 root 身份运行。"
    exit 1
fi

case "$(uname -m)" in
    x86_64)
        FILE_NAME="sublink_amd64"
        ;;
    aarch64|arm64)
        FILE_NAME="sublink_arm64"
        ;;
    *)
        echo "不支持的机器类型: $(uname -m)"
        exit 1
        ;;
esac

LATEST_RELEASE=$(curl --fail --silent --show-error \
    "https://api.github.com/repos/$REPO/releases/latest" |
    grep '"tag_name":' |
    sed -E 's/.*"([^"]+)".*/\1/')

if [ -z "$LATEST_RELEASE" ]; then
    echo "未找到可安装的发行版。"
    exit 1
fi

echo "正在安装 SublinkX $LATEST_RELEASE..."
TMP_FILE=$(mktemp)
TMP_MENU=$(mktemp)
trap 'rm -f "$TMP_FILE" "$TMP_MENU"' EXIT

curl --fail --silent --show-error --location --retry 3 \
    "https://github.com/$REPO/releases/download/$LATEST_RELEASE/$FILE_NAME" \
    -o "$TMP_FILE"

curl --fail --silent --show-error --location --retry 3 \
    -H "Cache-Control: no-cache" \
    -H "Pragma: no-cache" \
    "https://raw.githubusercontent.com/$REPO/$LATEST_RELEASE/menu.sh" \
    -o "$TMP_MENU"

mkdir -p "$INSTALL_DIR/db" "$INSTALL_DIR/template" "$INSTALL_DIR/logs"
if systemctl is-active --quiet sublink 2>/dev/null; then
    systemctl stop sublink
fi
install -m 755 "$TMP_FILE" "$INSTALL_DIR/sublink"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Sublink Service
After=network.target

[Service]
ExecStart=$INSTALL_DIR/sublink
WorkingDirectory=$INSTALL_DIR
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

install -m 755 "$TMP_MENU" /usr/bin/sublink

systemctl daemon-reload
systemctl enable --now sublink

echo "安装完成，当前版本: $("$INSTALL_DIR/sublink" --version)"
echo "默认账号 admin，默认密码 344817，默认端口 8000"
echo "输入 sublink 可呼出管理菜单"
