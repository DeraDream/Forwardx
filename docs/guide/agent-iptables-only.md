# 离线安装：仅 Agent + iptables

v1.0.2 构建生成 `forwardx-agent-iptables-only-v1.0.2-linux-amd64.tar.gz` 和 `forwardx-agent-iptables-only-v1.0.2-linux-arm64.tar.gz`。包内是独立编译的 `iptablesonly` Agent 二进制、`VERSION` 版本文件、systemd 安装脚本和 `forwardx` 本地菜单。轻量包版本由 `agent/IPTABLES_ONLY_VERSION` 独立维护（当前 `1.0.2`），不会改变标准 Agent 的 `AGENT_VERSION` 或触发普通 Agent 的更新提示；Agent 上报 `协议兼容版本-iptables-only.轻量包版本`，面板仍下发 iptables 规则和接收心跳，但把轻量 Agent 从标准更新检查、升级候选及标准升级指令中排除。轻量版通过单独的 `scripts/build-agent-iptables-only.sh` 和 `.github/workflows/release-agent-iptables-only.yml` 构建发布，标准 Agent Release 不包含该包；发布新版本时调整版本文件并创建匹配的 `iptables-only-vX.Y.Z` 标签。包内 `VERSION` 和 Agent 日志显示轻量包版本。**不含 iptables**，也不安装 GOST、FXP、Realm、socat、Nginx 或 mimic。使用前请在 VPS 上通过系统包管理器安装 `iptables`，并确保内核支持所需的 NAT/转发功能。仅支持 systemd 主机。

1. 在能下载 Release 的机器获取对应架构的压缩包，传到目标 VPS，解压：

   ```bash
   tar -xzf forwardx-agent-iptables-only-v1.0.2-linux-amd64.tar.gz
   ```

2. 在目标 VPS 上运行安装脚本：

   ```bash
   sudo bash install.sh
   ```

   首次安装会依次询问 **HTTP 正向代理地址**、**真实面板地址**、**Agent Token** 和 **本机公网 IPv4**，例如 `http://163.223.124.40:5555`、`https://forwardx.yforward7.com`、面板创建的 Token 和 `42.193.170.239`。受限 VPS 无法直连公网 IP 查询服务时请填写本机公网 IP；不会通过代理查询，以免误报中转机的 IP。按要求 Token 输入及已有值均会在终端明文显示，请勿在其他人旁观时操作。脚本创建 `/etc/forwardx/agent/config.json`（仅 root 可读），代理写入 systemd drop-in；面板地址必须是真实面板地址，不能填写代理地址。若无需代理，第一项留空即可。重装时保留已有配置，不再询问；如需变更代理，修改 `/etc/systemd/system/forwardx-agent-iptables-only.service.d/proxy.conf` 后执行 `systemctl daemon-reload && systemctl restart forwardx-agent-iptables-only`。

   安装成功后（交互终端）自动进入本地菜单；以后 SSH 登录输入 `forwardx` 即可打开，不会在登录时自动弹出。菜单包含：从本地目录升级（默认 `/root`）、修改 Token/代理/面板地址/公网 IP、查看服务状态、退出。升级时列出所选目录中匹配当前架构的包供选择，随后重新逐项询问所有配置；提示已有值，回车保留，代理与公网 IP 输入 `-` 清空。升级前备份二进制和配置，服务启动失败则恢复。升级不需要连接 GitHub。

   无交互终端时也可以通过 `FORWARDX_AGENT_PROXY_URL`、`FORWARDX_PANEL_URL`、`FORWARDX_AGENT_TOKEN`、`FORWARDX_AGENT_PUBLIC_IPV4` 环境变量提供这些值；注意避免在 shell 历史或进程列表中暴露 Token。

3. 检查运行状态：

   ```bash
   journalctl -u forwardx-agent-iptables-only -n 100 --no-pager
   ```

代理机必须能访问面板地址；HTTPS 面板要求 HTTP 正向代理支持 CONNECT，不能让 `NO_PROXY` 排除面板地址。Agent 主动经代理建立 SSE 连接、发送心跳并取得面板下发的操作；面板无需反向连接 Agent。SSE 中断时周期心跳仍会获取操作，无需修改面板。

安装脚本只检查本机的 `iptables`，设置 IPv4 转发并安装 systemd 服务；不会联网获取其它运行时。**在面板只给该主机分配 iptables 类型的转发规则**；其他类型没有运行时会失败。Agent 本身的心跳、注册和升级仍需通过面板网络；初次离线传文件不意味着运行时可以离线管理。轻量版使用独立的 `/usr/local/bin/forwardx-agent-iptables-only` 和 `forwardx-agent-iptables-only.service`；拒绝与正在运行的标准 Agent 共存，避免两者共用状态文件。轻量版忽略面板通过心跳或 SSE 发出的标准 Agent 升级指令，面板也不把它计入标准 Agent 更新提示或升级候选。后续升级将新版包手动上传至 VPS 后运行 `forwardx`，选择「从本地目录升级」。此包只提供最小运行时，不替代系统防火墙/安全组配置。
