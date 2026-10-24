# 阶段 1 执行交接文档（阶段收尾版）

> 目的：上下文被压缩后，凭本文档即可继续执行或启动阶段 2，无需重新探索。
> 最后更新：阶段 1 全部 16 个任务 + 最终代码审查完成（HEAD `79decbb`，分支 `phase1-core`）。

## 1. 基本事实

- 项目目录：`D:\minecraft server management`（Windows，Git Bash，Node v24.22.1，npm 11.19.1）
- 分支：`phase1-core`（未在 main/master 上提交；未使用 worktree；尚未合并回 main）
- 设计规格：`docs/superpowers/specs/2026-10-23-minecraft-server-panel-design.md`
- 实现计划：`docs/superpowers/plans/2026-10-23-minecraft-panel-phase1-core.md`（16 个任务，全部完成）
- 执行方式：原计划子代理逐任务执行，但子代理触发当日用量上限后改为会话内直接实现；仍按 TDD（失败测试 → 实现 → 全绿 → 提交），并在阶段结束用 `superpowers:requesting-code-review` 派发了一次整体审查（审查者实际运行了构建产物并复现问题）。
- 当前基线全绿：`npm test`（server 139 / web 23 / shared 6）、`npm run typecheck`、`npm run lint`、`npm run build`。
- 手工验收已做（真实浏览器 + 生产构建 + 假服务端 `fake-server.mjs` 目录）：初始化 → 登录 → 探测纳管 → 启动 → 实时控制台 → 发命令 → 停止 → 改设置 → 退出 → 再登录 → 深链刷新不 404 → 面板重启后进程消失被判 `已崩溃` 并给出原因。

## 2. 任务进度

| 计划任务 | 状态 | 提交 |
| --- | --- | --- |
| Task 1 仓库与 workspaces | ✅ | `5b23e94`、`5cf0f99`、`bb29672` |
| Task 2 共享契约 | ✅ | `4c3a298`、`57411d9` |
| Task 3 配置/日志/AppError | ✅ | `c0bff8c`、`025efc1`、`a769b78` |
| Task 4 数据库 schema/迁移 | ✅ | `fa5bd63`、`39d928c`、`7ee41ad` |
| Task 5 密码/会话/审计 | ✅ | `efc2370`、`e3752be` |
| Task 6 路径沙箱/探测 | ✅ | `1ab1af6`、`0a98c25`、`2f98898` |
| Task 7 进程驱动/控制台缓冲 | ✅ | `f03ef0a` |
| Task 8 RCON 服务 | ✅ | `1ae2e98` |
| Task 9 状态机 + Supervisor | ✅ | `bc24a3b` |
| Task 10 Fastify 骨架 + 认证路由 | ✅ | `42bd00f` |
| Task 11 实例/审计 API | ✅ | `d37ed90` |
| Task 12 指标 + 系统 API + WebSocket | ✅ | `f321209` |
| Task 13 前端基础 + 认证页 + AppShell + 仪表盘 | ✅ | `cb15860` |
| Task 14 实例列表 + 纳管 + 布局 + 概览 | ✅ | `b91ad28` |
| Task 15 控制台 + 命令输入 + 实例设置 | ✅ | `9ace2a9` |
| Task 16 启动入口 + 静态托管 + README + 验收 | ✅ | `2c9b87c` |
| 最终代码审查与收尾修复 | ✅ | `79decbb` |

## 3. 后端接口（前端已按此对接）

- 认证：`GET /api/auth/status` → `{setupRequired, authenticated, user}`；`POST /api/auth/setup|login|logout|password`；`GET /api/auth/csrf` → `{token}`。
  写请求需要 `Origin`（或 `Referer`）与 `X-CSRF-Token`；CSRF token 与会话绑定，**登录后旧 token 会返回 403 `CSRF_INVALID`，客户端必须重取 token 并重试一次**（`api/client.ts` 已实现，登录/登出/401 均调用 `clearCsrfToken()`）。
- 实例：`GET /api/instances` → `{items: InstanceInfo[]}`；`GET/POST/PATCH/DELETE /api/instances[/:id]`；`POST /api/instances/probe`；`POST .../actions/{start|stop|restart|kill|mark-stopped}`（202 + `{state}`）；`GET .../status`；`GET .../logs?lines=`；`GET .../logs/download`（attachment）；`POST .../console/command`。
  删除体 `{confirmName}`（必须与实例名完全一致，且 `lastState` 为 stopped/crashed）；mark-stopped 体 `{confirm:true}`；PATCH 至少一个字段。
  `rconStatus` 语义：未启用 RCON → `disabled`；从未探测且已启用 → `unreachable`；只有真正握手成功才是 `connected`。
- 审计：`GET /api/audit?page&pageSize&action` → `Paginated<AuditEntry>`。
- 系统：`GET /api/system/overview` → `SystemMetricsSample`（平铺）；`GET /api/health` 免认证。
- WS `/api/ws`（同源 Cookie + Origin）：客户端 `subscribe|unsubscribe|ping`；服务端 `hello`、`console.snapshot/append/gap`、`instance.state`、`metrics.sample`（样本在 `sample` 字段内）、`notification`、`pong`、`error`。阶段 1 订阅 `instance:*:players` 或 `task:*` 会收到 `error`（阶段 2/3 提供）。
- 统一错误体 `{error:{code,message,details}}`；未登录 `401 AUTH_REQUIRED`。

## 4. 测试与工具约定

- `test/helpers/db.ts` → `createTestDb()`（临时目录 + 真实迁移 + seed local 节点，`close()` 幂等）。
- `test/helpers/factory.ts` → `insertInstanceRow / insertInstance / insertUser`（rootPathKey 由 `toRootKey` 推导）。
- `test/helpers/http.ts` → `CookieJar`、`json<T>()`、`TEST_ORIGIN = 'http://localhost:80'`。
- 假服务端 `test/fixtures/fake-server.mjs`：支持 `--root`、`--gbk`、`--crash`、`--exit-after=ms`、`--ignore-stop`，写 `logs/latest.log` 并响应 stdin 的 `stop`。注意：stdin 关闭时它会自然退出，因此在面板之外手工拉起做孤儿测试需要保持 stdin 打开。
- 假 RCON `test/fixtures/fake-rcon.mjs`（+ `.d.mts`）：`startFakeRcon({password, port, saveAllDelayMs})`。
- WS 测试用带缓冲队列的 `TestSocket`；`apps/web` 用 `FakeWebSocket`（`test/realtime-connection.test.ts`）验证引用计数、退订、登出清空与"旧 socket 迟到 close 不影响新 socket"。
- `npm test -w @mcpanel/server` 的 cwd 是 `apps/server`，路径必须靠 `import.meta.url` 或仓库根解析（`.env`、`DATA_DIR`、`migrationsDir`、`webDistDir` 都已如此）。
- 前端测试约定：涉及 `useMutation/useQuery` 的组件测试必须包 `QueryClientProvider`；`vi.mock('../src/api/client')` 要提供 `api/ApiError/clearCsrfToken/UNAUTHORIZED_EVENT`；`Field` 的 hint 渲染在 `<label>` 外，否则 `getByLabelText('服务器目录')` 会因标签文本含提示而匹配失败。
- Git 提示 LF→CRLF 属正常；`*.sql` 由 `.gitattributes` 固定 LF。

## 5. 与计划的有意偏差（审查驱动，已提交）

后端（1–10）保持不变，见提交历史；新增：

11. **Task 3 收尾**：`NODE_ENV` 未设置时默认 **production**（显式非法值仍报错），`scripts/dev.mjs` 显式注入 `NODE_ENV=development`；`Field` 提示移出 label；`ConfirmDialog` 增加 `confirmDisabled`。
12. **Task 13**：`api/client.ts` 额外导出 `downloadFile()`（blob + `<a download>`），日志下载不再用 `window.location`，避免会话过期时把 SPA 替换成 JSON 页面；`main.tsx` 的 QueryClient 对 401/403 不重试；`useRealtime` 增加 `subscribed` 标志（没有订阅时不谎报"连接已断开"），并在 `apply` 里把服务端 `notification` 转成 toast（计划原本会静默丢弃）。
13. **Task 14**：纳管对话框用 label/value 分栏渲染探测摘要（便于断言与读屏），并在 `probe.rootPath !== rootPath` 时禁用"创建实例"并提示重新检测；实例名/启动命令/停止超时在前端先校验；登录成功后的 `next` 只接受站内绝对路径（防开放重定向）。
14. **Task 15**：控制台行渲染时间戳并改用主题变量 `--console-bg/--console-fg`（计划里写死深色），`warn/error` 用 `--warn/--danger`，`stream==='rcon'` 用主色；命令历史失败时保留输入。
15. **Task 16**：`shouldServeSpa` 增加"带扩展名的路径不返回 SPA 壳"和 query 剥离；`serveStatic` 仅在 production 开启且缺 `index.html` 时告警；`app.listen` 失败给出端口占用/权限的中文 fatal；`shutdown(reason, exitCode)` 崩溃退出码为 1、二次信号立即退出、10 秒兜底；Fastify `disableRequestLogging`（仪表盘每 15 秒轮询会刷屏）；生产日志同时写滚动文件与 stdout（计划里只有文件，`npm start` 终端看不到任何东西）。
16. **代码审查修复**（`79decbb`）：
    - `RconService.statusFor()` 读属性文件失败必须降级为 `unreachable`，否则一个损坏的 `server.properties` 会让 `GET /api/instances` 整体 415（审查者用真实构建复现，属严重回归）。
    - **`InstanceSupervisor.requireRuntime()` 改为按行惰性播种**：`init()` 之后再纳管的实例没有 runtime 记录，`start` 会抛 `NOT_FOUND`「实例不存在」→ 前端表现为 404，必须重启面板才能启动。这是阶段 1 最严重的功能缺陷，之前所有测试都先 `init()` 再操作，集成 API 测试又用的是 mock supervisor，所以没被发现；已补 `supervisor.test.ts` 回归用例。
    - 删除实例时调用 `supervisor.forget(id)` + `rcon.invalidate(id)`，避免 runtime/缓冲区泄漏。
    - 指标采样：一次 `si.processes()` 在 1 秒窗口内被同轮所有实例共享，且每个实例的整棵 PID 树用一次 `pidusage(pids)` 批量取（此前每 PID 一次 wmic + 每实例一次 PowerShell 枚举）。
    - 仪表盘与实例列表的状态徽章改为订阅 `instance:*:status`，不再停留在首次拉取的值。

## 6. 已知小问题与阶段 2 待办

- 未做（计划本就未含）：文件管理、`server.properties` 表单、玩家管理、备份/计划任务、`start-panel.bat`、`reset-password.mjs`、Playwright 冒烟。
- `POST /api/auth/password` 与 `GET /api/auth/me` 已实现且被测试覆盖，但阶段 1 没有前端入口（计划缺 `/settings` 页）；README 的"忘记密码"一节已如实说明。
- CSP 仍为 `connect-src 'self' ws: wss:`，`style-src` 含 `'unsafe-inline'`：收紧到同源 `ws` 需要确认目标浏览器后再改，属阶段 2 加固项。
- 构建产物是单个 ~786 kB（gzip 238 kB）chunk，recharts 被登录页一起拉进首屏；实例路由改 `React.lazy` 可显著减小首屏。
- `Field` 的 hint 未通过 `aria-describedby` 关联；`Dialog` 无 `description` 时 Radix 会告警；`index.html` 用 `<meta name="color-scheme">`（非标准）且 CSS 未声明 `color-scheme`，原生控件配色不随主题；`<html class="dark">` 硬编码会让浅色用户闪一下深色。
- `PathSandbox.resolve` 是 check-then-use，写操作存在 TOCTOU 残余风险（注释已说明）。
- `scripts/dev.mjs` 在 Windows 上 `child.kill()` 只杀 `cmd.exe`，可能留下占用 3000/5173 的孙进程。
- 面板启动时只对 `lastState != stopped` 的实例做孤儿恢复；若外部已经跑着服务器再纳管，面板不会立刻识别为 `orphaned`（阶段 2 可在 probe/create 时补一次恢复）。
- 计划文档仍有旧描述（`drizzle.config.ts`、Node 22+、`channelPattern`、WS 指标平铺字段），代码以仓库为准。

## 7. 下一步建议

1. `main` 已在阶段 1 收尾后创建并指向 `a25c29c`（与 `phase1-core` 同一提交），当前工作分支为 `main`；仓库没有配置远程，后续如需 PR 需先添加 remote。
2. 阶段 2 计划已写好：`docs/superpowers/plans/2026-10-24-minecraft-panel-phase2-players-files-config.md`（14 个任务；玩家、文件、配置、EULA、审计、面板设置）。按该计划执行，执行时以计划内的命令与预期结果为准。
3. 阶段 2 开工前先补一条端到端冒烟（Playwright 或脚本），把"纳管→启动→控制台→停止"固化为可重跑的检查，避免同类 runtime 缺陷再次只在手工验收里暴露。
