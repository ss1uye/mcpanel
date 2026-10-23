# 阶段 1 执行交接文档（持续更新）

> 目的：上下文被压缩后，凭本文档即可继续执行，无需重新探索。
> 最后更新：Task 7 完成后（HEAD `f03ef0a`）。

## 1. 基本事实

- 项目目录：`D:\minecraft server management`（Windows，Git Bash，Node v24.22.1，npm 11.19.1）
- 分支：`phase1-core`（Task 1 里 `git init` 后创建，**不要**在 main/master 上提交）
- 设计规格：`docs/superpowers/specs/2026-10-23-minecraft-server-panel-design.md`
- 实现计划：`docs/superpowers/plans/2026-10-23-minecraft-panel-phase1-core.md`（16 个任务）
- 执行方式：子代理逐任务执行 + 规格审查 + 质量审查。**当前子代理触发当日用量上限，已改为在当前会话内直接实现，仍按 TDD：先写失败测试→实现→全绿→提交。**

## 2. 验证命令（每次提交前必须全绿）

```bash
npm test -w @mcpanel/server    # 当前 14 文件 / 92 测试
npm test -w @mcpanel/shared    # 6 测试
npm test -w @mcpanel/web       # Task 13 起才有
npm run typecheck              # 三个工作区
npm run lint                   # 必须 0 error
npm ci --dry-run --strict-allow-scripts=true
```

## 3. 任务进度

| 计划任务 | 状态 | 提交 |
| --- | --- | --- |
| Task 1 仓库与 workspaces | ✅ | `5b23e94` + 修复 `5cf0f99`、`bb29672` |
| Task 2 共享契约 | ✅ | `4c3a298` + `57411d9` |
| Task 3 配置/日志/AppError | ✅ | `c0bff8c` + `025efc1`、`a769b78` |
| Task 4 数据库 schema/迁移 | ✅ | `fa5bd63` + `39d928c`、`7ee41ad` |
| Task 5 密码/会话/审计 | ✅ | `efc2370` + `e3752be` |
| Task 6 路径沙箱/探测 | ✅ | `1ab1af6` + `0a98c25` |
| Task 7 进程驱动/控制台缓冲 | ✅ | `2f98898`（沙箱补丁）、`f03ef0a` |
| Task 8 RCON 服务 | ⏳ 下一个 | — |
| Task 9 状态机 + Supervisor | ⏳ | — |
| Task 10 Fastify 骨架 + 认证路由 | ⏳ | — |
| Task 11 实例/审计 API | ⏳ | — |
| Task 12 指标 + 系统 API + WebSocket | ⏳ | — |
| Task 13 前端基础 + 仪表盘 | ⏳ | — |
| Task 14 实例列表 + 布局 + 概览 | ⏳ | — |
| Task 15 控制台 + 实例设置 | ⏳ | — |
| Task 16 启动入口 + 静态托管 + README + 验收 | ⏳ | — |
| 最终整体代码审查 | ⏳ | — |

## 4. 已完成任务中确立的关键约定

- `packages/shared` 只导出 TS 源码（`exports: "./src/index.ts"`），server 用 tsup 打包（`noExternal: ['@mcpanel/shared']`），web 用 Vite。
- 相对导入不带 `.js` 后缀（`moduleResolution: Bundler`）。
- 测试数据库：`apps/server/test/helpers/db.ts` 的 `createTestDb()`（临时目录 + 真实迁移 + seed local 节点，`close()` 幂等）。
- 工厂：`test/helpers/factory.ts` 的 `insertInstance` / `insertUser`。
- HTTP 测试用 `app.inject` + `test/helpers/http.ts` 的 `CookieJar`、`json`（Task 10 才用到）。
- 假服务端：`test/fixtures/fake-server.mjs`，支持 `--root`、`--gbk`、`--crash`、`--exit-after=ms`、`--ignore-stop`，会写 `logs/latest.log` 并响应 stdin 的 `stop`。
- `npm test -w @mcpanel/server` 的工作目录是 `apps/server`（路径不要依赖 `process.cwd()`）。

## 5. 与计划的有意偏差（审查驱动，已提交）

1. **Task 1**：`engines.node` 改为 `>=24.11.0`、`engines.npm >=11.16.0`、`packageManager: npm@11.19.1`；`@types/node ^24`、`typescript ~6.0.3`；新增 `.npmrc`（`strict-allow-scripts=true`）与 `package.json` 的 `allowScripts`（argon2/better-sqlite3/esbuild/fsevents）；ESLint 加 `globals` 并对 `**/*.mjs` 注入 Node globals；`.gitignore` 锚定 `/data/`、`/data-dev/`，加 `secret.key`、`.env.*`、`*.tsbuildinfo`；新增 `.gitattributes`（`*.sql text eol=lf`）。
2. **Task 2**：测试改用规范名 `WS_CHANNEL_PATTERN`，未保留 `channelPattern` 别名。
3. **Task 3**：`migrationsDir`/`webDistDir` 用 `import.meta.url` 解析（不再依赖 cwd）；`DATA_DIR` 相对路径以仓库根为基准；环境变量空白视为未设置；`MAX_UPLOAD_MB` 必须为正整数；布尔解析大小写不敏感并拒绝非法值；`NODE_ENV` 未识别值报错（默认仍是 development，Task 16 改为 production 默认）；`secret.key` 用 `flag:'wx'` 原子创建；pino 增加 redact、去掉无效的 `dateFormat`。
4. **Task 4**：所有 `TEXT PRIMARY KEY` 补 `NOT NULL`；`sessions`/`backups` 改为具名唯一索引；`schema.ts` 加 `users_username_unique`；`_migrations` 增加 `checksum` 并在应用前做全量校验（EOL 归一化后取 sha256）；旧 `_migrations`（无 checksum）明确报错要求删除 `data/panel.db`；已应用文件被删除/改名同样报错；**删除 `drizzle.config.ts` 与 `drizzle-kit`**（`0000_init.sql` 是唯一事实来源，测试守卫 `drizzle/` 只允许 `NNNN_*.sql`）。
5. **Task 5**：`SessionService.resolve()` 只返回 `{id,username,role}` 与 `{id,expiresAt}`，**不含 passwordHash/tokenHash**——Task 10 需要当前密码哈希时必须按 id 查 `users` 表；审计脱敏改为显式规范化黑名单 + `password|token|secret` 后缀（保留 bypass/compass/tokenCount）；分页 clamp 到 1..100 并按 `createdAt DESC, id DESC` 排序；无 logger 时审计写入失败退回 `console.error`。
6. **Task 6**：`ProbeService` 读 `server.properties`/`eula.txt` 必须走 `sandbox.resolve` + `lstat` 普通文件 + 1MB 上限，异常降级为 warning（`PROPERTIES_UNREADABLE`），不再泄漏目录外内容；`PathSandbox.resolve()` 会校验根目录本身是规范路径（被换成 junction 时拒绝）；Windows 段级拒绝 `:` / 结尾 `.` / 结尾空格；端口非法返回 `false`；Java 版本正则锚定行首；`/` 与 `''` 表示根目录（修了一个把 `.` 当成非法的回归）。
7. **Task 7**：Windows 使用 `windowsVerbatimArguments: true` 并把整条命令作为 `/c` 的单个参数（Node 默认的转义会让 `cmd.exe /c "...":` 嵌套引号报“文件名、目录名或卷标语法不正确”）；`buildShellCommand` 返回值增加 `verbatim`，并拒绝含 `"` 的根路径；`ConsoleBuffer.capacity` 公开；`since(0)` 返回 snapshot、仅在缓冲区被裁剪时 `gap: true`。

## 6. 尚未处理的已知小问题（可留到最终审查）

- `pino-pretty` 是 devDependency，生产 `--omit=dev` 时不能传 `pretty=true`（index.ts 需按 nodeEnv 决定）。
- `si.processes()` 较慢，只在恢复探测用；`verifyPid` 对“找到进程但命令行读不到”返回 true。
- `PathSandbox` 的 lstat 是 check-then-use，写操作存在 TOCTOU 残余风险（已在代码注释中说明）。
- 计划文档里仍写着 `drizzle.config.ts`、Node 22+ 等旧内容，最终收尾时可一并校正文档。

## 7. 下一步（Task 8 RCON 服务）要点

- 新建 `apps/server/src/services/rcon-service.ts`：按 `InstanceRow` 解析 target（`enable-rcon`/`rcon.port`/`rcon.password`/`server-ip`，实例 `rconHost` 优先），状态机 `disabled|auth_failed|unreachable|connected|disconnected`，5 秒连接超时，密码绝不落库/不进日志。
- `loadServerProperties(root, sandbox?)` 现在会拒绝符号链接；RCON 调用请传 `sandbox` 或不传（仅 root 内单文件）。
- 新建 `test/fixtures/fake-rcon.mjs`（最小 RCON 协议：type 3 认证，type 2 命令；密码错误回 id=-1 再断连）。
- Task 9 需要 `rcon.test(row)`、`rcon.send(row,'stop')`、`getCachedStatus(id)`、`invalidate(id)`、`closeAll()`。
- 注意 rcon-client 认证失败的错误文本可能不含 auth/password，若被判为 `unreachable` 需要按实际报错补匹配。
