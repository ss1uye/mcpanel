# MC Panel

自托管的 Minecraft Java 模组服管理面板。第一版面向单管理员、单机节点，纳管已经安装好的 Fabric / Forge / NeoForge 服务器目录，不接管安装流程。

## 当前阶段（阶段 1）

- 首次初始化、登录、会话与 CSRF 防护
- 纳管已有服务器目录（自动探测启动脚本、Java、server.properties、EULA、RCON 端口）
- 启动 / 停止 / 重启 / 强制结束，状态机校验与面板重启后的孤儿进程识别
- 实时控制台（虚拟滚动、WARN/ERROR 过滤、关键字搜索、日志下载）
- 命令输入（每实例历史记录，进程 stdin 或 RCON）
- 仪表盘系统指标与实例指标，WebSocket 实时推送
- 路径沙箱与审计日志基础能力

玩家管理、文件管理、配置编辑在阶段 2；备份、计划任务、Windows 一键启动在阶段 3。

## 环境要求

- Node.js 22+（推荐 24 LTS，仓库 `engines` 要求 `>=24.11.0`）
- npm 11.16+（用于依赖安装脚本白名单校验）
- Windows 10/11 或主流 Linux
- 同一台机器上已安装 Java 与 Minecraft 服务端

## 开发

```bash
npm install
npm run dev
```

- 后端：`http://127.0.0.1:3000`
- 前端：`http://127.0.0.1:5173`（Vite 代理 `/api` 与 WebSocket）
- 开发数据目录：`DATA_DIR=./data-dev npm run dev`，默认 `./data`

依赖安装会触发 `argon2`、`better-sqlite3`、`esbuild` 的构建脚本，npm 11 需要审批：
`npm install-scripts approve`（白名单已写入根 `package.json` 的 `allowScripts`）。

## 生产

```bash
npm run build
npm start
```

访问 `http://127.0.0.1:3000`，首次打开进入初始化页面。生产构建由 Fastify 托管 `apps/web/dist`，
刷新任意前端路由不会 404；未设置 `NODE_ENV` 时按 `production` 运行。

## 配置项

全部通过环境变量提供，无配置文件：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `production` | `development` / `test` / `production`，其他值直接报错 |
| `PANEL_HOST` | `127.0.0.1` | 监听地址；初始化完成前拒绝非回环地址 |
| `PANEL_PORT` | `3000` | 监听端口 |
| `DATA_DIR` | `data` | 数据目录，相对路径以仓库根为基准 |
| `COOKIE_SECURE` | `false` | 反向代理启用 HTTPS 后设为 `true` |
| `TRUST_PROXY` | `false` | 仅在使用可信反向代理时开启 |
| `LOG_LEVEL` | `info` | pino 日志级别 |
| `MAX_UPLOAD_MB` | `1024` | 上传体积上限（阶段 2 使用） |

仓库根目录的 `.env`（若存在）会在启动时载入；`.env` 已被 gitignore。

## 数据目录

```text
data/
├─ panel.db        SQLite 元数据（实例、会话、审计）
├─ secret.key      自动生成的会话与 CSRF 密钥（勿泄露）
├─ backups/        备份（阶段 3）
├─ tmp/            临时文件与回滚残留
└─ logs/panel.log  面板日志（10 MB 轮转）
```

实例的 `logs/latest.log` 等服务端文件始终留在实例自己的目录里，面板不会写入实例目录之外的位置。

## 安全

- 默认只监听 `127.0.0.1`；在完成初始化前拒绝绑定非回环地址。
- 面板进程拥有其系统账号的权限，`startCommand` 以同样权限执行。建议使用专用低权限账号，并只授予实例目录读写权限。
- 所有实例文件操作都被路径沙箱限制在实例根目录内，符号链接和 junction 一律拒绝。
- 不要把 `data/` 放在实例目录内，也不要让实例目录互相嵌套。
- 会话凭据与 RCON 密码只保存在内存中，不写入数据库，审计详情会脱敏。
- 直接关闭面板不会停止 Minecraft 服务器；服务器在面板重启后会被识别为 `orphaned` 或 `unknown` 并给出处理入口。
- 需要 HTTPS 请放在反向代理之后，并设置 `COOKIE_SECURE=true`。

## 测试

```bash
npm run typecheck
npm test
npm run lint
```

## 忘记密码

阶段 1 尚未提供重置脚本。忘记密码时可停止面板，删除 `data/panel.db` 中的 `users` 与 `sessions`
记录（会丢失实例注册信息，建议先备份 `panel.db`），重新打开面板完成初始化。阶段 3 提供
`scripts/reset-password.mjs`。
