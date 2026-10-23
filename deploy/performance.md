# Sublink 性能与日志部署建议

## Caddy 静态资源缓存

```caddyfile
sublink.your-domain.com {
    encode zstd gzip

    @static path /static/*
    header @static Cache-Control "public, max-age=31536000, immutable"

    reverse_proxy 127.0.0.1:5050
}
```

静态资源文件名带内容 hash，可以长期缓存。更新前端后文件名会变化，浏览器会自动拉取新文件。

## systemd 日志去重

创建 `/etc/systemd/system/sublink.service.d/logging.conf`：

```ini
[Service]
StandardOutput=null
StandardError=journal
```

应用：

```bash
systemctl daemon-reload
systemctl restart sublink
```

## journald 限额

创建 `/etc/systemd/journald.conf.d/limits.conf`：

```ini
[Journal]
SystemMaxUse=200M
RuntimeMaxUse=50M
MaxRetentionSec=7day
```

应用：

```bash
systemctl restart systemd-journald
```

## Cloudflare 订阅缓存

`/c/` 返回包含密钥的动态订阅，而且模板、节点修改后必须立即生效。Cloudflare Cache Rule 应对 `/c/*` 设置 `Bypass cache`，不要设置 Edge TTL 或 `Cache Everything`。应用只在本机短期缓存可安全识别变更的本地模板；远程模板不缓存。
