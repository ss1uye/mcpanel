# Linux systemd 部署

面板只监听回环地址，HTTPS 交给反向代理（Caddy/Nginx）。`data/` 与实例目录需要同一
个低权限账号可读写。

## 0. 前置条件

- Node.js 24.11+ 与 npm 11.16+（与 `package.json` 的 `engines` 一致）；
- 首次安装依赖若被 npm 11 拦截构建脚本，执行 `npm install-scripts approve`（白名单已在仓库配置中）。

## 1. 创建账号与目录

```bash
sudo useradd --system --home /opt/mcpanel --shell /usr/sbin/nologin mcpanel
sudo mkdir -p /opt/mcpanel /srv/minecraft
sudo chown -R mcpanel:mcpanel /opt/mcpanel /srv/minecraft
sudo chmod 700 /opt/mcpanel
```

把仓库放到 `/opt/mcpanel`，用 `mcpanel` 账号安装与构建：

```bash
sudo -u mcpanel bash -c 'cd /opt/mcpanel && npm ci && npm run build'
```

## 2. 环境文件

`/opt/mcpanel/.env`：

```ini
NODE_ENV=production
PANEL_HOST=127.0.0.1
PANEL_PORT=3000
DATA_DIR=./data
# 放在反向代理之后时打开：
# COOKIE_SECURE=true
# TRUST_PROXY=true
```

## 3. unit 文件

`/etc/systemd/system/mcpanel.service`：

```ini
[Unit]
Description=Minecraft Server Panel
After=network.target

[Service]
Type=simple
User=mcpanel
WorkingDirectory=/opt/mcpanel
EnvironmentFile=/opt/mcpanel/.env
ExecStart=/usr/bin/node apps/server/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mcpanel
sudo systemctl status mcpanel
```

## 4. 反向代理示例（Caddy）

```caddyfile
panel.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

启用 `COOKIE_SECURE=true` 与 `TRUST_PROXY=true` 后重启面板。

## 5. 停止与升级

```bash
sudo systemctl stop mcpanel          # 不会停止 Minecraft 服务器
cp data/panel.db /backup/panel-$(date +%F).db
sudo -u mcpanel bash -c 'cd /opt/mcpanel && git pull && npm ci && npm run build'
sudo systemctl start mcpanel          # 启动时自动迁移数据库
```

面板退出时只会关闭自己的连接，Minecraft 进程保持运行；重新启动后会在概览页把它们标记为
`未接管` 或 `状态未知`，按提示处理即可。

## 6. 日志与健康检查

- `journalctl -u mcpanel -f` 或 `data/logs/panel.N`（10 MB 轮转，保留 5 份）
- 忘记密码时停止面板后执行 `node scripts/reset-password.mjs`（会读取 `.env` 的 `DATA_DIR`）
- `curl http://127.0.0.1:3000/api/health` → `{"ok":true,"version":"0.4.0"}`
