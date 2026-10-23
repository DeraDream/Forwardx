<div align="center">
<img src="webs/src/assets/logo.png" width="150px" height="150px" />
</div>

<div align="center">
    <img src="https://img.shields.io/badge/Vue-5.0.8-brightgreen.svg"/>
    <img src="https://img.shields.io/badge/Go-1.22.0-green.svg"/>
    <img src="https://img.shields.io/badge/Element Plus-2.6.1-blue.svg"/>
    <img src="https://img.shields.io/badge/license-MIT-green.svg"/>
    <a href="https://t.me/+u6gLWF0yP5NiZWQ1" target="_blank">
        <img src="https://img.shields.io/badge/TG-交流群-orange.svg"/>
    </a>
    <div align="center"> 中文 | <a href="README.en-US.md">English</div>
</div>

## [项目简介]

项目基于sublink项目二次开发：https://github.com/jaaksii/sublink

前端基于：https://github.com/youlaitech/vue3-element-admin

后端采用go+gin+gorm

默认账号admin 密码344817  自行修改

因为重写目前还有很多布局结构以及功能稍少

## [项目特色]

自由度和安全性较高，能够记录访问订阅，配置轻松

二进制编译无需Docker容器

目前支持客户端：v2ray clash surge egern

v2ray为base64通用格式

clash支持协议:ss ssr trojan vmess vless hy hy2 tuic

surge支持协议:ss trojan vmess hy2 tuic

egern支持协议:ss trojan vmess vless hy2 tuic

## [项目预览]

![1712594176714](webs/src/assets/1.png)
![1712594176714](webs/src/assets/2.png)

## [版本规则]

从 2.7 开始，每次迭代版本递增 0.1，例如 2.8、2.9、3.0。

## [2.7更新说明]

- 修复 Docker 构建上下文错误，确保前端 `webs` 目录可被镜像构建读取
- Docker 构建阶段禁用 Husky，避免容器内缺少 Git 元数据导致安装异常
- Docker 工作流仅在 `main` 更新时构建镜像，Release 标签只负责二进制发布

## [2.6.1更新说明]

- 重构节点与订阅管理弹窗，采用更紧凑的扁平化布局
- 统一弹窗标题、表单字段、滚动内容区和底部操作区
- 优化二维码、客户端选择与访问记录弹窗
- 完善小屏幕和暗黑模式下的弹窗显示

## [2.6更新说明]

- 新增 Telegram 机器人配置页面与二级菜单
- 支持通过 Telegram 查看节点和订阅列表
- 支持通过 Telegram 添加、删除节点，并限制管理员 Chat ID

## [2.5更新说明]

- 模板编辑改为带行号、缩进和语法高亮的 YAML 编辑器
- 新增模板实时预览和浏览器导出功能
- 新增管理界面明暗主题切换，并适配暗黑模式

## [2.4更新说明]

#### 后端更新

1. 修复后台工作区未铺满页面的问题
2. 修复首次本地运行时配置目录未创建的问题

#### 前端更新

1. 重构订阅、节点、模板三个列表的工具栏、表格和批量操作区
2. 新增 macOS 本地开发脚本 `dev-macos.sh`




## [安装说明]
### linux方式：
```
curl -fsSL -H "Cache-Control: no-cache" -H "Pragma: no-cache" https://raw.githubusercontent.com/DeraDream/sublinkX/main/install.sh | bash
```

```sublink``` 呼出菜单

安装脚本会自动下载 GitHub Releases 中适合当前架构的预编译版本。

### docker方式：

在自己需要的位置创建一个目录比如mkdir sublinkx

然后cd进入这个目录，输入下面指令之后数据就挂载过来

需要备份的就是db和template
```
docker run --name sublinkx -p 8000:8000 \
-v $PWD/db:/app/db \
-v $PWD/template:/app/template \
-v $PWD/logs:/app/logs \
-d ghcr.io/deradream/sublinkx:latest
```

To support the development of my project, I plan to apply for a free VPS offered by ZMTO. My project currently involves Docker image support for multiple architectures (arm64 and amd64), as well as automation for building and pushing. Therefore, I am requesting a 4-core, 8GB RAM Ubuntu VPS with root access.

Thank you to the ZMTO team for your support. I look forward to leveraging this VPS to optimize my project's performance and development efficiency. If you have any questions or suggestions regarding my project, feel free to open an issue, and I will do my best to improve and optimize it.

Thank you for your attention and support!

Feel free to adjust any details as needed!

## Stargazers over time
[![Stargazers over time](https://starchart.cc/DeraDream/sublinkX.svg?variant=adaptive)](https://starchart.cc/DeraDream/sublinkX)
