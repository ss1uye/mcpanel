# MC Panel

[![CI](https://github.com/ss1uye/mcpanel/actions/workflows/ci.yml/badge.svg)](https://github.com/ss1uye/mcpanel/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/ss1uye/mcpanel?display_name=tag)](https://github.com/ss1uye/mcpanel/releases/latest)

自托管的 Minecraft Java 模组服管理面板。当前版本面向单管理员、单机节点，纳管已经安装好的 Fabric / Forge / NeoForge 服务器目录，不接管安装流程。

## 当前阶段（v0.4）

- 首次初始化、登录、会话与 CSRF 防护
- 纳管已有服务器目录（自动探测启动脚本、Java、server.properties、EULA、RCON 端口）
- 启动 / 停止 / 重启 / 强制结束，状态机校验与面板重启后的孤儿进程识别
- 实时控制台（虚拟滚动、WARN/ERROR 过滤、关键字搜索、日志下载）
- 命令输入（每实例历史记录，进程 stdin 或 RCON）
- 仪表盘系统指标与实例指标，WebSocket 实时推送
- 玩家管理：RCON 状态与一键启用、在线玩家、OP / 白名单 / 踢出 / 封禁 / 解封 / 游戏模式 / 广播，只读名单
- 文件管理：浏览、上传（流式、大小限制）、下载、文本编辑（修改时间冲突提示）、新建 / 重命名 / 删除、zip 解压（zip-slip 校验）、`mods/` 启用与禁用
- 配置：`server.properties` 分组表单与原始编辑（保留注释、顺序与换行），EULA 接受
- 审计页（动作前缀过滤、详情展开）与面板设置（名称、时区、保留天数、修改密码）
- 备份：严格一致性（`save-off` / `save-all flush` / 等待落盘 / `save-on`）、保留策略、下载与删除
- 恢复：`pre_restore` 安全备份、安全解压、目录交换与失败回滚、中断残留清理
- 定时任务：备份 / 启停 / 重启 / 命令 / 广播，cron + 时区、重叠跳过、运行记录
- 部署：Windows `scripts/start-panel.bat`、Linux systemd（`docs/systemd.md`）、`scripts/reset-password.mjs`
- 路径沙箱、审计日志与玩家动作固定命令模板
- 编辑器：文件与配置原始编辑使用 CodeMirror 6（行号、搜索、JSON / YAML / properties 高亮）
- 安全：CSP 使用每请求 nonce，WebSocket 仅允许当前 Host；反向代理需转发原始 Host 或 `X-Forwarded-Host`
- 面板数据：设置页一键下载 SQLite 在线快照，或使用 `scripts/backup-panel-db.mjs`
- 计划：列表与表单展示未来 3 次运行时间
- 前端：路由级懒加载，编辑器按需加载，sparkline 使用轻量 SVG
- 发版：Windows x64 服务器便携 ZIP；v0.4 新增 Electron 桌面版（安装器 + 便携 exe）

v0.4.0 新增 Windows 桌面版（Electron）：原生窗口、托盘、单实例、开机自启和首次数据导入，现有 Web 面板与 Minecraft 管理能力保持不变，无数据库结构变更。

## 下载（Windows x64）

从 [GitHub Releases](https://github.com/ss1uye/mcpanel/releases/latest) 下载：

**桌面版（推荐）**

- `MC-Panel-Setup-0.4.0.exe`：每用户安装器，无需管理员；数据在 `%APPDATA%\MC Panel`。
- `MC-Panel-0.4.0-portable.exe`：便携版，数据在 exe 旁的 `mcpanel-data/`。每次启动需要解压约 535 MB，首次可能较慢。
- 首次启动可导入现有 `data/`；关闭窗口默认最小化到托盘，退出桌面应用不会停止 Minecraft 服务器。
- 安装包未签名，Windows 可能提示“来源未知”；请从本仓库 Releases 下载并核对 SHA256。

**服务器便携版（无桌面环境/高级用户）**

- `mcpanel-0.4.0-win-x64.zip`：内置 Node 24，解压到有写权限的目录（例如 `D:\MC Panel`），双击 `start-panel.bat`。
- 不需要安装 Node.js 或 npm；数据在包内 `data/`。
- 关闭启动窗口即停止面板，不会停止 Minecraft 服务器。
- 详见 [`docs/portable.md`](docs/portable.md)。

下面的“环境要求/开发/生产”章节是针对**源码部署**的；桌面版和便携版用户可以直接跳过。

## 环境要求

- 桌面版：Windows 10/11 x64，无需安装 Node.js/浏览器（内置 Electron 与 Node 24）
- 源码运行：Node.js 24.11 及以上、npm 11.16+（`engines` 已强制）
- 服务器便携版：Windows 10/11 x64，无需 Node.js/npm
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

## 生产（源码部署）

```bash
npm run build
npm start
```

Windows 便携版见上文「下载便携版」；下面的步骤适用于从源码部署或需要 systemd 的 Linux 服务器。

访问 `http://127.0.0.1:3000`，首次打开进入初始化页面。生产构建由 Fastify 托管 `apps/web/dist`，
刷新任意前端路由不会 404；未设置 `NODE_ENV` 时按 `production` 运行。

Windows 可直接双击 `scripts/start-panel.bat`：它会检查 Node.js 版本、按需安装依赖与构建、
启动面板并打开浏览器。Linux 常驻见 `docs/systemd.md`。

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
├─ tmp/            打包临时文件（.part）
└─ logs/panel.N    面板日志（10 MB 轮转，保留 5 份）
```

生产模式下日志同时写入该滚动文件和标准输出，方便前台 `npm start` 直接观察。

实例的 `logs/latest.log` 与服务端文件始终留在实例目录里；恢复过程中的 `restore-*` / `rollback-*` 目录位于实例内的 `.mcpanel-tmp/`，面板不会写入实例目录之外的位置。

## 安全

- 默认只监听 `127.0.0.1`；在完成初始化前拒绝绑定非回环地址。
- 面板进程拥有其系统账号的权限，`startCommand` 以同样权限执行。建议使用专用低权限账号，并只授予实例目录读写权限。
- 所有实例文件操作都被路径沙箱限制在实例根目录内，符号链接和 junction 一律拒绝；上传先落到 `.mcpanel-tmp/`，校验大小后再原子改名。
- zip 解压拒绝绝对路径、`..` 条目、符号链接条目，并限制条目数与解压后体积。
- 玩家操作只使用固定命令模板（`kick <player> <reason>` 等），玩家名与原因在服务端再次校验，不接受任意命令。
- 不要把 `data/` 放在实例目录内，也不要让实例目录互相嵌套。
- 会话凭据与 RCON 密码只保存在内存中，不写入数据库，审计详情会脱敏。
- CSP 为每请求 nonce：`style-src` 不含 `'unsafe-inline'`，`connect-src` 只允许同源 WebSocket。放在反向代理后时请转发原始 `Host`（Nginx 默认 `proxy_set_header Host $host;`）；若使用 `TRUST_PROXY=true`，也可通过 `X-Forwarded-Host` 传递。
- 面板数据库快照包含密码哈希、会话哈希和审计记录，请按敏感文件保管。
- 直接关闭面板不会停止 Minecraft 服务器；服务器在面板重启后会被识别为 `orphaned` 或 `unknown` 并给出处理入口。
- 需要 HTTPS 请放在反向代理之后，并设置 `COOKIE_SECURE=true`。

## 备份与恢复

- 备份包含存档目录（`level-name` 及其 nether/end）、`server.properties`、`eula.txt`、名单文件，
  可选 `config/`、`defaultconfigs/`、`mods/`，以及最多 20 个额外路径；`logs/`、`cache/`、
  `libraries/` 与面板临时目录始终排除。
- 服务器运行中备份要求 RCON 可用：面板先关闭自动保存、刷盘并等待日志确认，再打包，结束后恢复保存。
- 恢复需要先停止服务器；恢复前会自动创建一份 `恢复前` 备份，失败时回滚已移动的目录。
- 保留策略按实例的「保留数量」，但最新一份 `恢复前` 备份始终保留。

## 面板数据库备份

「设置 → 面板数据备份」可下载 `panel-*.db` 在线快照（含账号、会话、审计与设置，不含 `.env` 与 `secret.key`）。
面板运行中也可执行：

```bash
node scripts/backup-panel-db.mjs [输出路径]
# 默认写入 data/backups-panel/panel-<时间戳>.db
```

恢复：停止面板，将快照复制为 `data/panel.db`（同时删除同目录的 `panel.db-wal` / `panel.db-shm`），再启动面板。

## 定时任务

- 标准 5 段 cron，按计划独立时区（默认取面板设置）。
- 支持备份、启动、停止、重启、发送命令、广播；面板离线期间错过的任务不会补跑。
- 同一计划上一次尚未结束时会记录为「跳过」；运行记录保留最近 100 条。

## 测试

```bash
npm run typecheck
npm test
npm run lint
npm run test:e2e     # Playwright 冒烟（Chromium，需先 npx playwright install chromium）
npm run release:portable   # Windows：生成便携 ZIP
npm run smoke:portable     # Windows：解压 ZIP 并真实启动验证
```

## 升级

1. 停止面板（不会停止 Minecraft）；
2. 用设置页或 `scripts/backup-panel-db.mjs` 生成面板数据库快照，并备份 `data/backups/`；
3. 更新代码后执行 `npm ci && npm run build`；
4. 重新启动，数据库迁移会自动执行。

## 启动失败排查

- 面板一直显示「启动中」但控制台已有 `[main/FATAL]`：先看实例的 `logs/latest.log`。Forge 1.20.1 需要 Java 17；出现 `Unsupported class file major version` 通常说明启动用的 Java 太新。
- 「Java 路径」填写绝对路径后，面板会把它所在目录放到启动环境的 `PATH` 前面，并设置 `JAVA_HOME`，`run.bat` / `run.sh` 里的 `java` 会优先使用它。
- 启动阶段出现 `Unsupported class file major version` 或 `UnsupportedClassVersionError` 时，面板会结束残留的启动器进程并标记为 `crashed`，不会一直卡在「启动中」。
- 服务器启动脚本末尾不要保留 `pause`；否则 Java 崩溃后包裹进程仍存活，面板无法通过进程退出来判断崩溃。

## 忘记密码

已登录时可在「设置 → 修改密码」中修改，修改后其他会话会被踢出。若已经无法登录，停止面板后执行：

```bash
node scripts/reset-password.mjs [用户名]   # 默认 admin，按提示输入两次新密码
```

脚本会重写密码哈希并清空所有会话，实例与备份数据不受影响。

## 许可证

[MIT](LICENSE)
