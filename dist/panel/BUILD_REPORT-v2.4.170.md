# ForwardX Panel/System v2.4.170 本地构建报告

- 范围：Panel 2.4.170 为独立轻量 Agent 增加 TCP 拓扑任务能力门禁；轻量 Agent 1.0.9 仅执行单任务拓扑 TCP 延迟探测。两个资产独立发布，均须更新；未修改标准 Agent 版本或运行时。
- Panel 版本检查、TypeScript 检查、10 项针对性 Node 测试、前后端构建和包校验通过；轻量/标准 Agent Go 测试、轻量 Agent vet、菜单/安装输入测试及 amd64/arm64 静态可达代码/禁止 sslocal 审计通过。未运行全套服务端测试或在真实 Telegram/Mkcloud 环境验证；TCP 建连不保证任意代理转发模式的最终应用响应。
- 标准 Agent `2.2.250`、FXP runtime `2.2.117`、Android APP `2.3.97` 不变；Panel 复用已校验标准 Agent/FXP/GOST 和 v2.4.166 SublinkX 运行时。未构建 Docker、Android APK 或标准 Agent 新包。
- Panel 包 SHA256：`97122b3e4dcc029926c7a77963c3a389f4e7a0994c82652d6156ae4b6e2eed34` (`forwardx-panel-v2.4.170.tar.gz`)。
- 独立轻量 Agent 1.0.9 SHA256：amd64 `d45862be6e6375499e2699754b1e4ba5a797340f3fa7b7d7c6c5af1dbb3e86aa`；arm64 `68a7766d335d6881789573d8f3a5ff31eafa389950f3fd1862f7ebda8500b7e2`。
- 未部署 Panel 或入口机；不修改线上转发规则、防火墙或日志。
