#!/bin/bash

REPO="DeraDream/sublinkX"
INSTALL_DIR="/usr/local/bin/sublink"
BIN_PATH="$INSTALL_DIR/sublink"
MENU_PATH="/usr/bin/sublink"
SERVICE_FILE="/etc/systemd/system/sublink.service"

function log_step {
    echo
    echo "==> $1"
}

function detect_arch {
    case "$(uname -m)" in
        x86_64)
            echo "sublink_amd64"
            ;;
        aarch64|arm64)
            echo "sublink_arm64"
            ;;
        *)
            echo "不支持的机器类型: $(uname -m)" >&2
            return 1
            ;;
    esac
}

function latest_release {
    curl --fail --show-error --location --retry 3 \
        "https://api.github.com/repos/$REPO/releases/latest" |
        grep '"tag_name":' |
        sed -E 's/.*"([^"]+)".*/\1/'
}

function is_installed {
    [ -x "$BIN_PATH" ] && [ -f "$SERVICE_FILE" ]
}

function is_running {
    systemctl is-active --quiet sublink 2>/dev/null
}

function current_version {
    if [ -x "$BIN_PATH" ]; then
        "$BIN_PATH" --version 2>/dev/null || echo "unknown"
    else
        echo "未安装"
    fi
}

function service_port {
    local port
    port=$(sed -nE 's/^ExecStart=.*--port[ =]([0-9]+).*/\1/p' "$SERVICE_FILE" 2>/dev/null | head -n 1)
    echo "${port:-8000}"
}

function reverse_proxy_domain {
    local port="$1"
    local config domain

    if systemctl is-active --quiet caddy 2>/dev/null && [ -f /etc/caddy/Caddyfile ]; then
        domain=$(awk -v port="$port" '
            /^[[:space:]]*[[:alnum:].-]+[[:space:]]*\{/ {
                site=$1
            }
            site != "" && $0 ~ "reverse_proxy" && $0 ~ ("(127\\.0\\.0\\.1|localhost):" port) {
                print site
                exit
            }
        ' /etc/caddy/Caddyfile)
        if [ -n "$domain" ]; then
            echo "$domain"
            return
        fi
    fi

    if systemctl is-active --quiet nginx 2>/dev/null; then
        for config in /etc/nginx/nginx.conf /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/*; do
            [ -f "$config" ] || continue
            if grep -Eq "proxy_pass[[:space:]]+http://(127\\.0\\.0\\.1|localhost):${port}" "$config"; then
                domain=$(awk '/^[[:space:]]*server_name[[:space:]]+/ { print $2; exit }' "$config" | tr -d ';')
                if [ -n "$domain" ] && [ "$domain" != "_" ] && [ "$domain" != "localhost" ]; then
                    echo "$domain"
                    return
                fi
            fi
        done
    fi
}

function panel_address {
    local port domain ip
    port=$(service_port)
    domain=$(reverse_proxy_domain "$port")
    if [ -n "$domain" ]; then
        echo "https://$domain"
        return
    fi
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    echo "http://${ip:-127.0.0.1}:$port"
}

function install_sublink {
    log_step "开始安装 SublinkX"
    echo "下载并执行安装脚本..."
    curl --fail --show-error --location --retry 3 --progress-bar \
        -H "Cache-Control: no-cache" \
        -H "Pragma: no-cache" \
        "https://raw.githubusercontent.com/$REPO/main/install.sh" |
        bash
}

function uninstall_sublink {
    log_step "完整卸载 SublinkX"
    read -r -p "将删除程序、数据库、模板和日志，确认继续？(y/N): " confirm
    if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
        echo "已取消卸载。"
        return
    fi

    echo "停止并禁用服务..."
    systemctl disable --now sublink 2>/dev/null || true
    echo "删除 systemd 服务和运行数据..."
    rm -f "$SERVICE_FILE" "$MENU_PATH"
    rm -rf "$INSTALL_DIR"
    systemctl daemon-reload
    systemctl reset-failed sublink 2>/dev/null || true
    echo "卸载完成：SublinkX 程序、数据库、模板和日志均已删除。"
}

function update_sublink {
    if ! is_installed; then
        echo "当前未安装 SublinkX，请先安装。"
        return 1
    fi

    log_step "检查 GitHub 最新版本"
    latest="$(latest_release)"
    if [ -z "$latest" ]; then
        echo "未找到可更新的发行版。"
        return 1
    fi

    version="$(current_version)"
    file_name="$(detect_arch)" || return 1
    updated_binary=0
    tmp_bin="$(mktemp)"
    tmp_menu="$(mktemp)"
    trap 'rm -f "$tmp_bin" "$tmp_menu"' RETURN

    log_step "下载最新菜单脚本"
    echo "下载进度："
    curl --fail --show-error --location --retry 3 --progress-bar \
        -H "Cache-Control: no-cache" \
        -H "Pragma: no-cache" \
        "https://raw.githubusercontent.com/$REPO/$latest/menu.sh" \
        -o "$tmp_menu" || {
            rm -f "$tmp_bin" "$tmp_menu"
            echo "菜单脚本下载失败，服务未更新。"
            return 1
        }

    echo "当前版本: $version"
    echo "最新版本: $latest"
    if [ "$version" != "$latest" ]; then
        log_step "下载主程序: $file_name"
        echo "下载进度："
        curl --fail --show-error --location --retry 3 --progress-bar \
            "https://github.com/$REPO/releases/download/$latest/$file_name" \
            -o "$tmp_bin" || {
                rm -f "$tmp_bin" "$tmp_menu"
                echo "主程序下载失败，服务未更新。"
                return 1
            }
        updated_binary=1
    else
        echo "主程序已是最新版本，仅刷新菜单脚本。"
    fi

    log_step "替换文件"
    chmod 755 "$tmp_menu"
    if [ "$updated_binary" = "1" ]; then
        chmod 755 "$tmp_bin"
    fi
    if [ "$updated_binary" = "1" ]; then
        if is_running; then
            systemctl stop sublink
        fi
        install -m 755 "$tmp_bin" "$BIN_PATH"
    fi
    install -m 755 "$tmp_menu" "$MENU_PATH"

    if [ "$updated_binary" = "1" ]; then
        systemctl daemon-reload
        systemctl start sublink
    fi

    rm -f "$tmp_bin" "$tmp_menu"
    trap - RETURN
    if [ "$updated_binary" != "1" ]; then
        echo "菜单脚本更新完成，当前版本: $version"
        return 0
    fi

    if is_running; then
        echo "更新完成，当前版本: $("$BIN_PATH" --version)"
        echo "最近服务日志："
        journalctl -u sublink -n 12 --no-pager 2>/dev/null || true
    else
        echo "更新完成，但服务没有正常启动。最近服务日志："
        journalctl -u sublink -n 30 --no-pager 2>/dev/null || true
        return 1
    fi
}

function start_sublink {
    if ! is_installed; then
        echo "当前未安装 SublinkX，请先安装。"
        return 1
    fi
    systemctl daemon-reload
    systemctl start sublink
    echo "服务已启动"
}

function stop_sublink {
    if ! is_installed; then
        echo "当前未安装 SublinkX。"
        return 1
    fi
    systemctl stop sublink
    systemctl daemon-reload
    echo "服务已停止"
}

function service_status {
    if ! is_installed; then
        echo "当前未安装 SublinkX。"
        return 1
    fi
    systemctl status sublink
}

function show_workdir {
    echo "运行目录: $INSTALL_DIR"
    echo "需要备份的目录为 db 和 template，logs 可按需备份。"
    cd "$INSTALL_DIR" || return 1
}

function change_port {
    if ! is_installed; then
        echo "当前未安装 SublinkX，请先安装。"
        return 1
    fi

    read -p "请输入新的端口号: " port
    echo "新的端口号: $port"
    parameter="run --port $port"
    if [ ! -f "$SERVICE_FILE" ]; then
        echo "服务文件不存在: $SERVICE_FILE"
        return 1
    fi

    if grep -q "run --port" "$SERVICE_FILE"; then
        echo "参数已存在，正在替换..."
        sed -i "s/--port [0-9]\+/--port $port/" "$SERVICE_FILE"
    else
        sed -i "/^ExecStart=/ s|$| $parameter|" "$SERVICE_FILE"
        echo "参数已添加到 ExecStart 行: $parameter"
    fi

    systemctl daemon-reload
    systemctl restart sublink
    echo "服务已重启。"
}

function reset_account {
    if ! is_installed; then
        echo "当前未安装 SublinkX，请先安装。"
        return 1
    fi

    read -p "请输入新的账号: " user
    read -p "请输入新的密码: " password
    cd "$INSTALL_DIR" || return 1
    "$BIN_PATH" setting --username "$user" --password "$password" &
    pid=$!
    wait "$pid"
    systemctl restart sublink
    echo "账号密码已重置，服务已重启。"
}

function Select {
    status="未安装"
    if is_installed; then
        if is_running; then
            status="已运行"
        else
            status="未运行"
        fi
    fi

    latest="$(latest_release 2>/dev/null || true)"
    version="$(current_version)"

    clear
    echo "SublinkX 管理菜单"
    echo "----------------"
    echo "最新版本: ${latest:-获取失败}"
    echo "当前版本: $version"
    echo "当前状态: $status"
    echo "面板地址: $(panel_address)"
    echo

    if ! is_installed; then
        echo "1. 安装"
    else
        echo "1. 完整卸载"
    fi
    echo "2. 更新"
    if is_installed; then
        if is_running; then
            echo "3. 停止服务"
        else
            echo "3. 启动服务"
        fi
    fi
    echo "4. 查看服务状态"
    echo "5. 查看运行目录"
    echo "6. 修改端口"
    echo "7. 重置账号密码"
    echo "0. 退出"
    echo -n "请选择一个选项: "
    read option

    case $option in
        1)
            if ! is_installed; then
                install_sublink
            else
                uninstall_sublink
            fi
            ;;
        2)
            update_sublink
            ;;
        3)
            if ! is_installed; then
                echo "当前未安装 SublinkX。"
            elif is_running; then
                stop_sublink
            else
                start_sublink
            fi
            ;;
        4)
            service_status
            ;;
        5)
            show_workdir
            ;;
        6)
            change_port
            ;;
        7)
            reset_account
            ;;
        0)
            exit 0
            ;;
        *)
            echo "无效的选项，请重新选择。"
            ;;
    esac
}

Select
