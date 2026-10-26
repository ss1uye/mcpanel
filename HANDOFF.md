# MC Panel 交接文档

> 最后更新：2026-10-26 · 版本 v0.3.1 · 分支 `main` · 远程 `origin` = `git@github.com:ss1uye/mcpanel.git`（公开）· 工作树：发布准备中
> 用途：上下文压缩或换人接手后，凭本文档即可继续，无需重新探索。

## 1. 一句话状态

自托管 Minecraft Java 模组服管理面板（v0.3，单管理员/单机）：阶段 1–3、v0.2 打磨与 v0.3 Windows 便携发版全部完成。测试、类型、Lint、构建、Playwright 冒烟、便携包冒烟全绿；CI 双平台 + Ubuntu e2e + gitleaks 通过。本地已纳管真实实例 `fuwuduan`（Forge 1.20.1-47.4.0，使用便携 JRE 17）。

## 2. 恢复工作（三步）

```bash
cd "D:\minecraft server management"
npm install            # Node >= 24.11、npm >= 11.16（engines 已强制）
npm run build && npm start        # 生产：http://127.0.0.1:3000
# 或开发：后端 3000 + Vite（默认 5173；被占用时见第 3 节）
```

验证基线（应全绿）：

```bash
npm run typecheck      # 0 错误
npm test               # server 237 / web 59 / shared 12
npm run lint
npm run build
npm run test:e2e       # Playwright Chromium，约 10s
npm run release:portable   # Windows x64 便携 ZIP
npm run smoke:portable     # 解压 ZIP 后真实启动并检查 health/首页/数据
```

## 3. 当前会话的运行状态（压缩后可能已失效）

- 开发后端：`npm run dev -w @mcpanel/server`，`127.0.0.1:3000`（tsx watch）。
- 开发前端：`npm run dev -w @mcpanel/web -- --port 5174 --strictPort`，页面 `http://localhost:5174/`。
  - **注意**：5173 被本机另一个 `electron-vite` 进程占用；Vite 只监听 `::1`，用 `127.0.0.1:5174` 访问会失败，需用 `localhost`。
- 数据目录：`./data`（已 gitignore），已初始化管理员 `admin`。**密码不记录在文档中**；若遗忘，停服后执行
  `node scripts/reset-password.mjs admin` 重置（会清空会话）。
- 停止方式：用会话里的后台任务停止，或按端口找 PID：`netstat -ano | grep :3000` / `:5174`。
- 尚未纳管实例；下一步通常是「实例 → 纳管实例」。

## 4. 文档索引

| 文档 | 内容 |
| --- | --- |
| `docs/superpowers/specs/2026-10-23-minecraft-server-panel-design.md` | 完整技术规格（唯一需求事实来源） |
| `docs/superpowers/specs/2026-10-24-mcpanel-v0.2-design.md` | v0.2 打磨与加固设计 |
| `docs/superpowers/plans/2026-10-24-minecraft-panel-phase2-players-files-config.md` | 阶段 2 计划（玩家/文件/配置） |
| `docs/superpowers/plans/2026-10-24-minecraft-panel-phase3-backups-schedules-deploy.md` | 阶段 3 计划（备份/计划/部署/e2e） |
| `docs/superpowers/plans/2026-10-24-mcpanel-v0.2-polish.md` | v0.2 实现计划 |
| `docs/superpowers/plans/HANDOFF-phase1.md` | 阶段 1 收尾、接口约定、偏差 1–10 |
| `docs/superpowers/plans/HANDOFF-phase2.md` | 阶段 2 收尾与手工验收 |
| `docs/superpowers/plans/HANDOFF-phase3.md` | 阶段 3 收尾、审查结论、遗留风险 |
| `docs/superpowers/plans/HANDOFF-phase4.md` | v0.2 收尾、决策与验证记录 |
| `docs/superpowers/specs/2026-10-26-mcpanel-portable-release-design.md` | v0.3 便携发版设计 |
| `docs/superpowers/plans/2026-10-26-mcpanel-portable-release.md` | v0.3 便携发版计划 |
| `docs/portable.md` | Windows 便携版下载、启动、升级、迁移与排障 |
| `README.md` | 安装/开发/生产/备份与恢复/定时任务/安全/升级/忘记密码 |
| `docs/systemd.md` | Linux 部署 |

## 5. 代码地图

```text
apps/server/src/
├─ index.ts             启动入口：加载 .env、迁移、恢复、组装服务、启动调度器、优雅退出
├─ app.ts               Fastify 组装：cookie/CSRF/multipart/WS/静态托管/错误映射/路由注册
├─ routes/              auth, instances, files, config, rcon, players, backups, schedules, audit, settings, system
├─ services/            instance-service/supervisor/state-machine/console-buffer/rcon/players/
│                       file-service/properties(-patch)/backup-*/restore/schedule/task-tracker/
│                       audit/settings/metrics
├─ nodes/               path-sandbox（所有文件访问必须经过）、local-driver、process-tree、java-detect、port-check
├─ ws/hub.ts            console/state/metrics/task 频道，backpressure 与空闲断开
└─ db/                  schema + 手写 drizzle/0000_init.sql + 迁移校验
apps/web/src/
├─ api/client.ts        CSRF 会话绑定 + 单次重试、401 事件、流式下载（File System Access API，blob 回退）、multipart 上传
├─ stores/realtime.ts   WS 引用计数、重连退避、console/metrics/state/tasks 切片
├─ pages/               Dashboard/Instances/Audit/Settings + instance/{Overview,Console,Players,Files,Config,Backups,Schedules,Settings}
├─ components/          UI 原语、ErrorBoundary、PlayerList、FileBrowser/Editor、PropertiesForm、BackupList、ScheduleForm、TaskProgress…
packages/shared/        types/constants/errors/zod schemas（浏览器安全，不得 import node:*）
scripts/                dev.mjs、start-panel.bat、reset-password.mjs、clean-e2e.mjs
e2e/                    Playwright 冒烟（global-setup 造临时假服务端）
```

## 6. 关键事实与约定

- **路径安全**：任何实例文件访问都必须走 `PathSandbox.resolve`（拒绝 `..`、盘符、符号链接/junction、与 `data/` 或其它实例重叠）。恢复流程同样逐路径走沙箱，manifest 只允许严格相对路径。
- **备份一致性**：运行中备份必须 RCON 可用：`save-off` → `save-all flush` → 等 `logs/latest.log` 出现 `Saved the game|Saved the world`（60s）→ 打包 → `finally save-on`；否则拒绝（`BACKUP_REQUIRES_STOP_OR_RCON`）。
- **恢复**：仅 `stopped`；先做 `pre_restore` 冷备份；解压到实例内 `.mcpanel-tmp/restore-*`，把现存源移到 `rollback-*` 再交换；失败回滚移动与新建路径；非空 `rollback-*` 阻止再次恢复，启动时把实例置为 `unknown`，概览页可确认清理。
- **锁**：`InstanceSupervisor.runExclusive` 同时串行化启动/停止/重启/强杀/备份/恢复；路由用同步 `assertIdle` 返回 409 `BACKUP_BUSY`。
- **启动命令**：POSIX 下驱动会把裸 `start.sh` / `run.sh` 补成 `./…` 再交给 `/bin/sh`，避免 PATH 不含当前目录导致 `command not found`。
- **Java 路径**：实例的 `java_path` 既用于启动前校验，也会在启动时把其所在目录前置到 `PATH` 并设置 `JAVA_HOME`；启动阶段出现 `Unsupported class file major version` / `UnsupportedClassVersionError` 会结束残留启动器并标记 `crashed`。
- **指标采样**：单次采集失败（例如 Windows 上的 `EBUSY`）只记录 `warn` 并跳过本次，不再触发进程级 unhandledRejection 导致面板退出。
- **便携发版**：`npm run release:portable` 生成 `release/mcpanel-<version>-win-x64.zip`；包内含 `process.execPath` 对应的 Node 24、服务端生产依赖、前端/后端构建、`start-panel.bat`、`scripts/reset-password.mjs`、Node 许可证；不含 `.env`、`data/`、测试或源码。`npm run smoke:portable` 解压并真实启动验证。
- **计划任务**：croner、独立时区、重叠跳过、不补跑、每计划保留 100 条运行记录；删除实例前先 `forgetInstance`；列表/创建/更新返回 `nextRuns`（3 条），`GET /api/instances/:id/schedules/preview` 供表单预览。
- **CSP**：每请求 nonce；`style-src 'self' 'nonce-…'`；`connect-src 'self' ws://<Host> wss://<Host>`；`TRUST_PROXY=true` 时优先 `X-Forwarded-Host`。HTML 模板 `apps/web/index.html` 的 `__CSP_NONCE__` 由服务端按请求替换（`no-store`）；CodeMirror 用 `EditorView.cspNonce`，Radix 动态样式通过 `window.__webpack_nonce__`。
- **面板库快照**：`PanelBackupService` 使用 better-sqlite3 `backup()` 写入 `data/tmp/panel-*.db`，下载流关闭后删除；CLI 为 `scripts/backup-panel-db.mjs`；审计动作 `panel.backup`。
- **审计动作**：`auth.*`、`instance.*`、`file.*`、`config.update`、`console.command`、`player.*`、`backup.create/delete/download/restore/restore_failed`、`schedule.*`、`settings.update`、`panel.backup`。
- **WS**：`/api/ws` 同源 + 会话 Cookie；频道 `instance:<id>:{console,status,metrics,players}`、`system:metrics`、`task:<taskId>`；`players` 频道仍返回 403（玩家页走 REST 轮询）。
- **配置**：`NODE_ENV` 默认 production（非法值报错）；`PANEL_HOST/PORT`、`DATA_DIR`、`COOKIE_SECURE`、`TRUST_PROXY`、`LOG_LEVEL`、`MAX_UPLOAD_MB`；仓库根 `.env` 由 `import.meta.url` 定位。
- **提交约定**：小步提交；每次 `typecheck + test + lint` 全绿；不提交 `data/`、`data-e2e/`；文档不写凭据。

## 7. 仓库配套

- 许可证：MIT（`LICENSE`）。
- 依赖安全：`@fastify/static` 10.1.7、`drizzle-orm` 0.45.4、`zod` 4.6.7；`npm audit --omit=dev --audit-level=high` 为 0 漏洞。
- CI：`.github/workflows/ci.yml`，`main` push 与 PR 触发四个 job（`concurrency` 同分支去重，npm 11.19.1）：
  `static`（ubuntu：typecheck + lint + 生产依赖审计，审计显式使用 npmjs registry）、`test`（ubuntu + windows 矩阵：test + build；Windows 额外打包/冒烟便携包）、
  `e2e`（ubuntu：Playwright Chromium）、`secret-scan`（gitleaks 全历史）。
- 发布：`.github/workflows/release.yml`，`v*` tag 或手动触发，在 Windows 上构建便携 ZIP、冒烟、上传 artifact；tag 时创建 GitHub Release（ZIP + SHA256SUMS）。
- 已发布 v0.3.0：https://github.com/ss1uye/mcpanel/releases/tag/v0.3.0（tag 指向 `212b5b8`，ZIP 57,099,945 bytes，SHA256 `c6daa52129cfd1bc8dabec8656bfac7fb7e0c0d2c5515cef0186998d151e86a7`）。
- 密钥扫描：`.gitleaks.toml`；测试/文档中的已知测试凭据通过白名单排除。
- 仓库描述与 topics 需在 GitHub 网页设置（API 写入需要 token，本项目只用 SSH）。

## 8. 已验证的能力

- 生命周期：纳管 → 探测（启动脚本/Java/properties/EULA/RCON）→ 启动/停止/重启/强杀 → 孤儿恢复。
- 控制台：实时流、环形缓冲 5000 行、日志尾部回放、级别/搜索过滤、下载、命令历史。
- 玩家：RCON 状态与一键启用、在线列表、OP/白名单/踢出/封禁/解封/模式/广播、只读名单。
- 文件：列表/编辑（mtime 冲突）/上传/下载/新建/改名/删除/解压/模组启停。
- 配置：分组表单 + 原始编辑（保留注释/顺序/EOL/重复键）、EULA。
- 备份/恢复：严格冻结、manifest、保留策略、pre_restore、回滚、残留清理。
- 计划：CRUD、立即运行、运行记录、时区。
- 运维：审计页、面板设置与改密码、`start-panel.bat`、systemd 文档、`reset-password.mjs`、Playwright 冒烟；WS 心跳看门狗 75 秒无收包强制重连。
- 编辑：CodeMirror 6（行号、搜索、JSON/YAML/properties 高亮），按需加载。
- 安全：CSP nonce、Host 限定 WebSocket；生产环境无 CSP 违规（e2e 断言）。
- 面板数据：设置页一键下载 SQLite 在线快照；CLI 可在面板运行时备份。
- 计划：列表与表单展示未来 3 次运行时间。
- 前端：路由级懒加载；首屏入口 `index` 161.0 kB + `react` 258.0 kB（gzip 52.0 + 81.9 kB），`CodeEditor` 436.9 kB（gzip 142.9 kB）按需加载；sparkline 改为纯 SVG，recharts 与 `charts` 分包已移除；web 仅从 `@mcpanel/shared/constants` 取运行时值，避免 zod/schemas 进入首屏。
- 性能：控制台日志按 60ms 批量推送、前端按 seq 增量去重；系统指标改用 `os.*`，实例指标并行采样并共享进程枚举；备份一次遍历生成文件清单并复用，文件列表分批并发 stat；`server.properties` 按 mtime/ctime/size 缓存并在面板写入后失效；玩家数据只在运行/孤儿状态轮询；删除实例改用异步清理备份目录。
- 发版：Windows x64 便携 ZIP（内置 Node 24，约 55 MB），双击 `start-panel.bat`，用 Edge 打开；数据在包内 `data/`。

## 9. 已知限制（可接受，未阻塞 v0.3）

1. 备份 manifest 只做结构/路径校验，未与数据库存证做哈希比对；面板生成的备份可信，手工替换 zip 仍会被路径校验拦截。
2. 运行中备份与「面板之外的进程终止」存在窄竞态；面板内的启停已被实例锁串行化。
3. CSP 的 `connect-src` 依据请求 Host（`TRUST_PROXY=true` 时优先 `X-Forwarded-Host`）；反向代理若既改写 Host 又不传 `X-Forwarded-Host`，浏览器会拦截 WebSocket。
4. Playwright 覆盖初始化、纳管、启停、控制台、备份/恢复、CodeMirror 保存、面板库快照与 375px；上传超限、zip-slip、mtime 冲突、失败恢复仍由集成测试覆盖。
5. 面板库快照只含 `panel.db`；恢复需停面板并手工替换文件，`.env` 与 `secret.key` 需单独保存。
6. `data/` 只存在于本机；`data-e2e/`、`test-results/` 等已 gitignore。
7. Linux 上孤儿 PID 身份校验可能失准：`sh -c` 对末条命令做 exec 优化后 cmdline 不含实例路径，且 `systeminformation` 抛错时按"已验证"处理——面板重启后可能把运行中的服务器误标为 crashed（`instance-supervisor.ts` recover）。
8. 上传与解压没有磁盘空间预检（备份/恢复已有）。
9. 登录限速按 `request.ip`：`TRUST_PROXY=true` 且前面没有净化 `X-Forwarded-For` 的反代时可被伪造头绕过；共享出口 IP 时可反向锁死管理员 15 分钟。
10. WS 连接在会话吊销（登出/改密码）后仍存活到断开为止；前端上传无进度/不可取消。
11. 面板进程异常退出时，Windows 上启动器 `cmd.exe` 可能先退出而 JVM 继续运行；重启后面板按 `last_pid` 只会把实例标记为 `crashed`，无法接管该 JVM，需要人工结束进程后重新启动实例。
12. 便携版没有安装器、Windows 服务、自动启动或自动更新；关闭控制台即停止面板，升级需手动替换并保留 `data/`。
13. 便携 ZIP 未签名，Windows/杀软可能提示来源未知；需从 Releases 下载并核对 SHA256，解压到可写目录（不要放 `C:\Program Files`）。
14. 便携包约 55 MB（含 Node 24 与生产依赖）；首次启动在包内创建 `data/`。

## 10. 建议的下一步

1. 纳管一个真实测试服，跑一遍手工验收矩阵（规格 §21.4），重点：Windows 中文/空格路径、面板重启时的孤儿检测、运行中严格备份、恢复、反向代理下的 CSP/`X-Forwarded-Host`。
2. 可选增强：备份 manifest 的 SHA-256 存证与完整性校验、备份到外部存储（S3/WebDAV）、告警 Webhook、远程节点/多用户（规格 §24）。
3. 发版增强（按需）：代码签名、Windows 安装器/服务、自动更新、Linux 包或 Docker。
4. 若继续用 AI 代理：先读本文件，再读 `HANDOFF-phase4.md`、v0.3 便携发版计划与 `docs/portable.md`，按“测试先行 + 小步提交”的方式推进。
