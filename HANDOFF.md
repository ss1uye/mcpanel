# MC Panel 交接文档

> 最后更新：2026-10-24 · 分支 `main` · 远程 `origin` = `git@github.com:ss1uye/mcpanel.git`（私有）· 工作树干净
> 用途：上下文压缩或换人接手后，凭本文档即可继续，无需重新探索。

## 1. 一句话状态

自托管 Minecraft Java 模组服管理面板（v0.1，单管理员/单机）**阶段 1–3 全部完成**，已通过独立代码审查并修复全部 Critical/Important 问题；测试、类型、Lint、构建、Playwright 冒烟全绿。当前在本地开发环境运行，管理员已初始化，尚未纳管任何实例。

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
npm test               # server 206 / web 45 / shared 11
npm run lint
npm run build
npm run test:e2e       # Playwright Chromium，约 10s
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
| `docs/superpowers/plans/2026-10-24-minecraft-panel-phase2-players-files-config.md` | 阶段 2 计划（玩家/文件/配置） |
| `docs/superpowers/plans/2026-10-24-minecraft-panel-phase3-backups-schedules-deploy.md` | 阶段 3 计划（备份/计划/部署/e2e） |
| `docs/superpowers/plans/HANDOFF-phase1.md` | 阶段 1 收尾、接口约定、偏差 1–10 |
| `docs/superpowers/plans/HANDOFF-phase2.md` | 阶段 2 收尾与手工验收 |
| `docs/superpowers/plans/HANDOFF-phase3.md` | 阶段 3 收尾、审查结论、遗留风险 |
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
├─ api/client.ts        CSRF 会话绑定 + 单次重试、401 事件、blob 下载、multipart 上传
├─ stores/realtime.ts   WS 引用计数、重连退避、console/metrics/state/tasks 切片
├─ pages/               Dashboard/Instances/Audit/Settings + instance/{Overview,Console,Players,Files,Config,Backups,Schedules,Settings}
├─ components/          UI 原语、PlayerList、FileBrowser/Editor、PropertiesForm、BackupList、ScheduleForm、TaskProgress…
packages/shared/        types/constants/errors/zod schemas（浏览器安全，不得 import node:*）
scripts/                dev.mjs、start-panel.bat、reset-password.mjs、clean-e2e.mjs
e2e/                    Playwright 冒烟（global-setup 造临时假服务端）
```

## 6. 关键事实与约定

- **路径安全**：任何实例文件访问都必须走 `PathSandbox.resolve`（拒绝 `..`、盘符、符号链接/junction、与 `data/` 或其它实例重叠）。恢复流程同样逐路径走沙箱，manifest 只允许严格相对路径。
- **备份一致性**：运行中备份必须 RCON 可用：`save-off` → `save-all flush` → 等 `logs/latest.log` 出现 `Saved the game|Saved the world`（60s）→ 打包 → `finally save-on`；否则拒绝（`BACKUP_REQUIRES_STOP_OR_RCON`）。
- **恢复**：仅 `stopped`；先做 `pre_restore` 冷备份；解压到实例内 `.mcpanel-tmp/restore-*`，把现存源移到 `rollback-*` 再交换；失败回滚移动与新建路径；非空 `rollback-*` 阻止再次恢复，启动时把实例置为 `unknown`，概览页可确认清理。
- **锁**：`InstanceSupervisor.runExclusive` 同时串行化启动/停止/重启/强杀/备份/恢复；路由用同步 `assertIdle` 返回 409 `BACKUP_BUSY`。
- **计划任务**：croner、独立时区、重叠跳过、不补跑、每计划保留 100 条运行记录；删除实例前先 `forgetInstance`。
- **审计动作**：`auth.*`、`instance.*`、`file.*`、`config.update`、`console.command`、`player.*`、`backup.create/delete/download/restore/restore_failed`、`schedule.*`、`settings.update`。
- **WS**：`/api/ws` 同源 + 会话 Cookie；频道 `instance:<id>:{console,status,metrics,players}`、`system:metrics`、`task:<taskId>`；`players` 频道仍返回 403（玩家页走 REST 轮询）。
- **配置**：`NODE_ENV` 默认 production（非法值报错）；`PANEL_HOST/PORT`、`DATA_DIR`、`COOKIE_SECURE`、`TRUST_PROXY`、`LOG_LEVEL`、`MAX_UPLOAD_MB`；仓库根 `.env` 由 `import.meta.url` 定位。
- **提交约定**：小步提交；每次 `typecheck + test + lint` 全绿；不提交 `data/`、`data-e2e/`；文档不写凭据。

## 7. 已验证的能力

- 生命周期：纳管 → 探测（启动脚本/Java/properties/EULA/RCON）→ 启动/停止/重启/强杀 → 孤儿恢复。
- 控制台：实时流、环形缓冲 5000 行、日志尾部回放、级别/搜索过滤、下载、命令历史。
- 玩家：RCON 状态与一键启用、在线列表、OP/白名单/踢出/封禁/解封/模式/广播、只读名单。
- 文件：列表/编辑（mtime 冲突）/上传/下载/新建/改名/删除/解压/模组启停。
- 配置：分组表单 + 原始编辑（保留注释/顺序/EOL/重复键）、EULA。
- 备份/恢复：严格冻结、manifest、保留策略、pre_restore、回滚、残留清理。
- 计划：CRUD、立即运行、运行记录、时区。
- 运维：审计页、面板设置与改密码、`start-panel.bat`、systemd 文档、`reset-password.mjs`、Playwright 冒烟。

## 8. 已知限制（可接受，未阻塞第一版）

1. 备份 manifest 只做结构/路径校验，未与数据库存证做哈希比对；面板生成的备份可信，手工替换 zip 仍会被路径校验拦截。
2. 运行中备份与「面板之外的进程终止」存在窄竞态；面板内的启停已被实例锁串行化。
3. 下载备份未校验记录状态（失败/创建中的记录下载会 404/500）。
4. 文件编辑器是 `<textarea>`（非规格里的 CodeMirror 6）；足够可用，缺语法高亮。
5. 计划表单不预览「未来 3 次运行」，列表只显示下次/上次运行时间。
6. Playwright 只覆盖冷备份路径与 375px 概览；上传超限、zip-slip、mtime 冲突、失败恢复由集成测试覆盖。
7. 前端单 chunk 约 800 kB（gzip ~240 kB），recharts 进入首屏；实例路由未做 lazy。
8. 面板自身数据库（`data/panel.db`）需手工备份。
9. CSP 仍为 `connect-src 'self' ws: wss:`、`style-src` 含 `'unsafe-inline'`，可按部署收紧。
10. `data/` 只存在于本机；`data-e2e/`、`test-results/` 等已 gitignore。

## 9. 建议的下一步

1. ~~添加 remote 并推送~~ 已完成：`origin` 指向私有仓库 `git@github.com:ss1uye/mcpanel.git`，`main` 已推送并跟踪。后续改动直接 `git push`。
2. 纳管一个真实测试服，跑一遍手工验收矩阵（规格 §21.4），重点：Windows 中文/空格路径、面板重启时的孤儿检测、运行中严格备份、恢复。
3. 可选增强：CodeMirror 编辑器、路由 lazy + 代码分包、CSP 收紧、面板库在线备份脚本、远程节点/告警/多用户（规格 §24）。
4. 若继续用 AI 代理：先读本文件，再读阶段 3 计划与 `HANDOFF-phase3.md`，按“测试先行 + 小步提交”的方式推进。
