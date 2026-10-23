# Minecraft 服务器管理面板 · 技术设计规格

- 日期：2026-10-23
- 状态：设计已确认，待实现
- 版本：v0.1（第一版）
- 项目目录：`D:\minecraft server management`

## 1. 摘要

做一个自托管的 Web 面板，用来管理**已经安装好**的 Java 模组服（Fabric / Forge / NeoForge）。第一版只支持单管理员、单机节点，覆盖四块能力：

1. 实例生命周期与实时控制台；
2. RCON 玩家管理与命令；
3. 文件、模组与 `server.properties` 配置管理；
4. 严格一致的备份恢复与定时任务。

架构上把“面板后端”和“真正接触进程与文件的节点执行层”分开。第一版只实现 `LocalNodeDriver`，实例表保留 `nodeId`，将来接远程 Agent 时页面、数据库和业务逻辑不推翻。

## 2. 目标与非目标

### 2.1 目标

- 在一个页面里完成服务器日常运维：启动、停止、重启、看日志、发命令。
- 纳管已有服务器目录，不改动、不迁移用户现有的服务端文件。
- 玩家管理、文件管理、配置修改、备份恢复、定时任务形成闭环。
- Windows 双击即用，Linux 可按 systemd 常驻；不需要 Docker。
- 默认安全：只监听本机、单管理员、路径沙箱、审计日志。
- 关键流程可测试：进程状态机、路径沙箱、配置补丁、备份恢复。

### 2.2 非目标（第一版明确不做）

- 一键安装/下载 Minecraft 服务端。
- 整合包导入、模组依赖解析、模组更新。
- 多用户、角色权限、公开注册。
- 远程节点 Agent（只保留接口和数据库字段）。
- 长期指标存储、告警平台、Webhook。
- Docker 管理。
- 面板内 TLS（建议反向代理）。
- 崩溃后自动重启、面板启动时自动拉起服务器。
- 从外部服务拉取玩家皮肤（避免运行时依赖外网）。
- Bedrock 基岩版、代理服（BungeeCord/Velocity）的专门适配。
- 在线人数历史、经济系统、插件专属功能。
- 文件回收站；删除即删除，依靠确认框、审计和备份兜底。

## 3. 用户与典型场景

只有一个角色：**管理员**。管理员是可信用户，拥有面板所在机器的操作权限。

典型场景：

- **日常巡检**：打开仪表盘看所有实例状态、在线人数、CPU/内存、磁盘剩余、最近备份。
- **开服/关服**：在实例顶部直接启动、停止、重启，切换页签时状态和操作始终可见。
- **排障**：看实时控制台，按 WARN/ERROR 过滤，搜索日志，下载 `latest.log`。
- **玩家管理**：看在线列表，执行 OP/白名单/踢人/封禁/广播。
- **改配置**：表单修改 `server.properties`，或直接编辑 `config/` 下的模组配置。
- **运营**：设置每天凌晨自动备份、每周定时重启，查看每次任务的结果。
- **恢复**：停服后从备份恢复存档，恢复前自动再做一次安全备份。

## 4. 约束与假设

- Java 运行时和服务端文件已存在；面板只负责管理和启动，不负责安装 Java。
- 第一版面板与 Minecraft 服务器在**同一台主机**上，面板进程有权限读写实例目录。
- 支持 Windows 10/11 与主流 Linux；开发机为 Windows，Node.js 24 已安装。
- Node.js 最低 22，推荐 24 LTS。
- 浏览器为最近两个大版本的 Chrome、Edge、Firefox；不支持 IE。
- 界面语言为简体中文；代码标识符和日志使用英文。
- 不引入 Mojang 官方素材。Logo、图标、玩家头像均为自制或本地生成。
- 运行时不需要访问外网；所有前端资源打包在本地。
- 备份文件、`server.properties` 和日志可能包含敏感信息，按管理员数据对待。

## 5. 技术选型

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 运行时 | Node.js 24 LTS | 开发机已具备 |
| 语言 | TypeScript 5.x，`strict` | 前后端共享类型 |
| 后端框架 | Fastify 5 | REST + 静态资源托管 |
| WebSocket | `@fastify/websocket`（ws） | 控制台、状态、指标、任务进度 |
| 数据库 | SQLite + `better-sqlite3` + Drizzle ORM | WAL 模式，单文件 |
| 参数校验 | Zod | 前后端共享 schema |
| 密码哈希 | `argon2`（argon2id） | 仅单管理员 |
| 压缩 | `archiver` 打包，`yauzl` 解包 | 流式处理，防 zip-slip |
| RCON | `rcon-client` | 每实例惰性连接 |
| 定时 | `croner` | 支持 IANA 时区 |
| 指标 | `pidusage` + `systeminformation` | 进程与系统指标 |
| 日志 | `pino` + `pino-roll` | JSON 日志，按大小轮转 |
| 前端 | React 19 + Vite 7 + Tailwind CSS 4 | SPA |
| UI 基础 | Radix UI 原语 + 自制组件 | 不整包引入重型组件库 |
| 图标 | `lucide-react` | 本地打包 |
| 数据请求 | TanStack Query v5 | 服务端状态 |
| 实时状态 | Zustand | 控制台缓冲、WS 状态 |
| 编辑器 | CodeMirror 6 | 轻量文本编辑 |
| 图表 | Recharts | 仪表盘 sparkline |
| 测试 | Vitest + Testing Library + Playwright | 单元、组件、端到端 |
| 包管理 | npm workspaces | 不引入额外 monorepo 工具 |

依赖版本在实现时锁定到当时的稳定版并写入 `package-lock.json`；不在规格中固定补丁号。

## 6. 系统架构

### 6.1 组件图

```text
┌──────────────────────────────────────────────────────────┐
│ 浏览器 SPA（React）                                       │
│ 仪表盘 / 实例详情 / 玩家 / 文件 / 配置 / 备份 / 计划 / 审计 │
└───────────────┬──────────────────────────┬───────────────┘
                │ REST（同源 Cookie）       │ WebSocket
┌───────────────▼──────────────────────────▼───────────────┐
│ Fastify 面板后端                                          │
│  接入层：认证、CSRF、限流、Zod、审计、静态资源             │
│  服务层：InstanceSupervisor / RCON / FileService /        │
│          BackupService / Scheduler / Metrics / TaskQueue   │
└───────────────┬──────────────────────────────────────────┘
                │ NodeDriver 接口
┌───────────────▼──────────────────────────────────────────┐
│ LocalNodeDriver（v1）                                     │
│  child_process / 进程树 / fs 沙箱 / RCON / archiver        │
│  AgentNodeDriver（预留，不实现）                           │
└───────────────┬──────────────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────────────┐
│ Minecraft Java 实例（Fabric / Forge / NeoForge）           │
│  world/ mods/ config/ logs/ server.properties              │
└──────────────────────────────────────────────────────────┘

共享存储：
  data/panel.db        SQLite 元数据
  data/backups/        备份包
  data/tmp/            备份临时文件
  data/logs/           面板日志
```

### 6.2 运行形态

- 生产环境是**单个 Node 进程**：Fastify 同时提供 `/api`、`/api/ws` 和构建后的 SPA 静态文件。
- 开发环境两个进程：Fastify（热重载）+ Vite dev server；Vite 代理 `/api` 和 `/api/ws` 到后端。
- 每个受管实例对应一个 Java 子进程；面板进程退出**不会**主动杀死这些子进程。
- 面板重启后通过 PID、命令行和 RCON 做接管探测，具体见第 9 节。

### 6.3 `NodeDriver` 边界

第一版只实现 `LocalNodeDriver`。接口按“节点上的操作”定义，不把 Node 流暴露给上层，方便未来 Agent 用 HTTP 传输替代。

```ts
interface NodeDriver {
  probe(): Promise<NodeInfo>;

  validateRoot(rootPath: string): Promise<RootValidation>;
  browseDirectory(path: string): Promise<DirEntry[]>;
  listFiles(root: string, relPath: string): Promise<FileEntry[]>;
  readText(root: string, relPath: string): Promise<TextFile>;
  writeText(root: string, relPath: string, content: string, expectedMtime?: number): Promise<{ mtime: number }>;
  upload(root: string, relPath: string, stream: Readable, maxBytes: number): Promise<{ size: number }>;
  download(root: string, relPath: string): Readable;
  mkdir(root: string, relPath: string): Promise<void>;
  rename(root: string, relPath: string, newName: string): Promise<void>;
  remove(root: string, relPath: string, recursive: boolean): Promise<void>;
  unzip(root: string, relPath: string, targetDir: string): Promise<void>;

  startProcess(spec: StartSpec): Promise<ProcessSnapshot>;
  stopProcess(instanceId: string, timeoutSec: number): Promise<void>;
  killProcessTree(instanceId: string): Promise<void>;
  writeStdin(instanceId: string, line: string): Promise<void>;
  getProcessSnapshot(instanceId: string): ProcessSnapshot | null;
  verifyPid(pid: number, rootPath: string): Promise<boolean>;

  rcon(instance: RconTarget, command: string): Promise<string>;
  testRcon(instance: RconTarget): Promise<RconProbe>;

  metrics(instanceId: string, pid?: number): Promise<InstanceMetrics>;

  archive(root: string, sources: string[], destFile: string, signal: AbortSignal): Promise<ArchiveResult>;
  extract(root: string, archiveFile: string, destDir: string, signal: AbortSignal): Promise<void>;
}
```

进程输出通过 `LocalNodeDriver` 上的事件总线发出：`process.output`、`process.exit`，由 `InstanceSupervisor` 消费。未来的远程 Agent 在驱动内部把 WS 消息转成同样的事件，不改上层。

### 6.4 并发模型

- 每个实例一把**操作互斥锁**：启动、停止、重启、强杀、备份、恢复、恢复后的文件替换串行执行。
- 每个实例一把**任务锁**：备份与恢复互斥；同一实例同一时间只允许一个备份或恢复任务。
- 文件写入、配置保存、玩家操作不加全局锁，但受路径 mtime 校验和实例状态约束。
- 调度器使用单线程定时器；任务触发后投递到实例锁，拿不到锁则记录 `skipped`。
- 面板级全局限制：同时最多 2 个备份任务（跨实例），避免磁盘 IO 打满。

## 7. 目录结构

```text
D:\minecraft server management\
├─ package.json                  npm workspaces 根
├─ package-lock.json
├─ tsconfig.base.json
├─ .env.example
├─ .gitignore
├─ README.md
├─ docs/
│  └─ superpowers/specs/2026-10-23-minecraft-server-panel-design.md
├─ scripts/
│  ├─ start-panel.bat            Windows 双击启动
│  ├─ reset-password.mjs         忘记密码时重置
│  └─ dev.mjs                    同时起后端和前端
├─ apps/
│  ├─ server/
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  ├─ drizzle.config.ts
│  │  ├─ drizzle/                迁移 SQL
│  │  ├─ src/
│  │  │  ├─ index.ts             启动入口
│  │  │  ├─ app.ts               Fastify 组装
│  │  │  ├─ config.ts            环境变量
│  │  │  ├─ db/
│  │  │  │  ├─ client.ts
│  │  │  │  ├─ schema.ts
│  │  │  │  └─ migrate.ts
│  │  │  ├─ auth/
│  │  │  │  ├─ session.ts
│  │  │  │  ├─ password.ts
│  │  │  │  └─ guard.ts
│  │  │  ├─ routes/
│  │  │  │  ├─ auth.ts
│  │  │  │  ├─ instances.ts
│  │  │  │  ├─ console.ts
│  │  │  │  ├─ players.ts
│  │  │  │  ├─ files.ts
│  │  │  │  ├─ config.ts
│  │  │  │  ├─ backups.ts
│  │  │  │  ├─ schedules.ts
│  │  │  │  ├─ audit.ts
│  │  │  │  ├─ system.ts
│  │  │  │  ├─ settings.ts
│  │  │  │  └─ ws.ts
│  │  │  ├─ services/
│  │  │  │  ├─ instance-supervisor.ts
│  │  │  │  ├─ state-machine.ts
│  │  │  │  ├─ rcon-service.ts
│  │  │  │  ├─ file-service.ts
│  │  │  │  ├─ properties-service.ts
│  │  │  │  ├─ backup-service.ts
│  │  │  │  ├─ restore-service.ts
│  │  │  │  ├─ scheduler-service.ts
│  │  │  │  ├─ metrics-service.ts
│  │  │  │  ├─ task-queue.ts
│  │  │  │  └─ audit-service.ts
│  │  │  ├─ nodes/
│  │  │  │  ├─ driver.ts
│  │  │  │  ├─ local-driver.ts
│  │  │  │  ├─ path-sandbox.ts
│  │  │  │  ├─ process-tree.ts
│  │  │  │  └─ java-detect.ts
│  │  │  ├─ ws/
│  │  │  │  └─ hub.ts
│  │  │  └─ utils/
│  │  └─ test/
│  │     ├─ unit/
│  │     ├─ integration/
│  │     └─ fixtures/fake-server.mjs
│  └─ web/
│     ├─ package.json
│     ├─ vite.config.ts
│     ├─ index.html
│     └─ src/
│        ├─ main.tsx
│        ├─ router.tsx
│        ├─ api/client.ts
│        ├─ ws/client.ts
│        ├─ stores/
│        ├─ pages/
│        │  ├─ SetupPage.tsx
│        │  ├─ LoginPage.tsx
│        │  ├─ DashboardPage.tsx
│        │  ├─ InstancesPage.tsx
│        │  ├─ InstancesPage/...
│        │  ├─ AuditPage.tsx
│        │  └─ SettingsPage.tsx
│        ├─ layouts/
│        │  ├─ AppShell.tsx
│        │  └─ InstanceLayout.tsx
│        ├─ pages/instance/
│        │  ├─ OverviewTab.tsx
│        │  ├─ ConsoleTab.tsx
│        │  ├─ PlayersTab.tsx
│        │  ├─ FilesTab.tsx
│        │  ├─ ConfigTab.tsx
│        │  ├─ BackupsTab.tsx
│        │  ├─ SchedulesTab.tsx
│        │  └─ InstanceSettingsTab.tsx
│        ├─ components/
│        └─ styles/
├─ packages/
│  └─ shared/
│     ├─ package.json
│     └─ src/
│        ├─ schemas/
│        ├─ types.ts
│        └─ constants.ts
└─ data/                         运行时生成，加入 .gitignore
   ├─ panel.db
   ├─ secret.key
   ├─ backups/
   ├─ tmp/
   └─ logs/
```

## 8. 数据模型

SQLite 配置：`journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5000`、`synchronous=NORMAL`。所有时间存 Unix 毫秒整数，API 输出 ISO 8601 UTC 字符串。主键统一 UUID v4 文本。

### 8.1 `users`

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PK |
| username | TEXT | NOT NULL，UNIQUE COLLATE NOCASE，3–32 字符 |
| password_hash | TEXT | NOT NULL |
| role | TEXT | NOT NULL DEFAULT 'admin'，CHECK IN ('admin') |
| created_at | INTEGER | NOT NULL |
| updated_at | INTEGER | NOT NULL |

### 8.2 `sessions`

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PK |
| user_id | TEXT | NOT NULL，FK users ON DELETE CASCADE |
| token_hash | TEXT | NOT NULL UNIQUE（SHA-256） |
| expires_at | INTEGER | NOT NULL，索引 |
| created_at | INTEGER | NOT NULL |
| ip | TEXT | |
| user_agent | TEXT | |

### 8.3 `nodes`

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PK |
| name | TEXT | NOT NULL |
| kind | TEXT | NOT NULL，CHECK IN ('local','agent') |
| base_url | TEXT | 远程节点预留 |
| token_enc | TEXT | 远程节点预留 |
| created_at | INTEGER | NOT NULL |

启动时幂等插入 `id='local', name='本机', kind='local'`。

### 8.4 `instances`

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PK |
| node_id | TEXT | NOT NULL，FK nodes |
| name | TEXT | NOT NULL，UNIQUE COLLATE NOCASE，1–60 字符 |
| root_path | TEXT | NOT NULL，规范化绝对路径 |
| root_path_key | TEXT | NOT NULL；Windows 下小写化并统一为 `/`，Linux 保持大小写、仅统一分隔符 |
| start_command | TEXT | NOT NULL，1–2000 字符 |
| java_path | TEXT | 可空；为空时自动探测 |
| stop_timeout_sec | INTEGER | NOT NULL DEFAULT 30，范围 10–300 |
| log_encoding | TEXT | NOT NULL DEFAULT 'utf-8'，CHECK IN ('utf-8','gbk') |
| rcon_host | TEXT | 可空；为空时从 properties 推导 |
| backup_keep | INTEGER | NOT NULL DEFAULT 10，范围 1–100 |
| backup_include_mods | INTEGER | NOT NULL DEFAULT 0，0/1 |
| backup_include_config | INTEGER | NOT NULL DEFAULT 1，0/1 |
| backup_extra_paths | TEXT | NOT NULL DEFAULT '[]'，JSON 字符串数组，最多 20 项 |
| last_state | TEXT | NOT NULL DEFAULT 'stopped'，见状态机 |
| last_pid | INTEGER | 可空 |
| last_started_at | INTEGER | 可空 |
| last_exit_code | INTEGER | 可空 |
| last_error | TEXT | 可空，最多 2000 字符 |
| created_at | INTEGER | NOT NULL |
| updated_at | INTEGER | NOT NULL |

索引与约束：

- `UNIQUE(node_id, root_path_key)`；
- 名称唯一，避免列表和选择器歧义；
- `root_path` 创建后不允许修改；换目录需删除实例后重新纳管；
- 不存 RCON 密码，密码始终从 `server.properties` 读取。

### 8.5 `schedules`

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PK |
| instance_id | TEXT | NOT NULL，FK instances ON DELETE CASCADE |
| name | TEXT | NOT NULL，1–60 字符 |
| cron | TEXT | NOT NULL，标准 5 段表达式 |
| timezone | TEXT | NOT NULL，IANA 时区，如 Asia/Shanghai |
| action_type | TEXT | CHECK IN ('backup','start','stop','restart','command','broadcast') |
| payload_json | TEXT | NOT NULL DEFAULT '{}' |
| enabled | INTEGER | NOT NULL DEFAULT 1 |
| last_run_at | INTEGER | 可空 |
| next_run_at | INTEGER | 可空，便于列表展示 |
| created_at | INTEGER | NOT NULL |
| updated_at | INTEGER | NOT NULL |

`payload_json`：

- `command`：`{ "command": "say 服务器将在 5 分钟后重启" }`，最长 1000 字符；
- `broadcast`：`{ "message": "服务器将在 5 分钟后重启" }`，最长 200 字符；
- 其他动作：`{}`。

### 8.6 `schedule_runs`

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PK |
| schedule_id | TEXT | NOT NULL，FK schedules ON DELETE CASCADE |
| trigger | TEXT | CHECK IN ('scheduled','manual') |
| status | TEXT | CHECK IN ('running','success','failed','skipped') |
| message | TEXT | 可空，最多 2000 字符 |
| started_at | INTEGER | NOT NULL |
| finished_at | INTEGER | 可空 |

每个计划最多保留最近 100 条运行记录，超出后删除最旧记录。

### 8.7 `backups`

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PK |
| instance_id | TEXT | NOT NULL，FK instances ON DELETE CASCADE |
| filename | TEXT | NOT NULL，UNIQUE(instance_id, filename) |
| kind | TEXT | CHECK IN ('manual','scheduled','pre_restore') |
| status | TEXT | CHECK IN ('creating','ready','failed','restoring') |
| size_bytes | INTEGER | 可空 |
| includes_mods | INTEGER | NOT NULL DEFAULT 0 |
| manifest_json | TEXT | 可空 |
| error | TEXT | 可空 |
| created_at | INTEGER | NOT NULL |
| completed_at | INTEGER | 可空 |

备份文件实际路径：`data/backups/<instanceId>/<filename>`。

### 8.8 `audit_logs`

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PK |
| user_id | TEXT | 可空，FK users ON DELETE SET NULL |
| action | TEXT | NOT NULL |
| target_type | TEXT | NOT NULL |
| target_id | TEXT | 可空 |
| detail_json | TEXT | NOT NULL DEFAULT '{}' |
| ip | TEXT | 可空 |
| created_at | INTEGER | NOT NULL |

索引：`(created_at)`、`(action)`、`(target_type, target_id)`。保留 90 天或最多 20,000 条，每天清理一次。

### 8.9 `settings`

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| key | TEXT | PK |
| value | TEXT | NOT NULL |
| updated_at | INTEGER | NOT NULL |

已确认的键：

- `panel_name`：默认 `MC Panel`；
- `default_timezone`：默认系统时区；
- `audit_retention_days`：默认 90。

## 9. 实例状态机与进程管理

### 9.1 状态定义

| 状态 | 含义 |
| --- | --- |
| `stopped` | 未运行，面板没有进程句柄 |
| `starting` | 已拉起进程，尚未确认启动完成 |
| `running` | 进程受面板托管，控制台可用 |
| `stopping` | 已请求停止，等待退出 |
| `crashed` | 非预期退出，保留退出码和最后日志 |
| `orphaned` | 面板重启后进程仍在，RCON 可连通，但控制台未接管 |
| `unknown` | 发现残留 PID 或异常状态，无法确认是否可管理 |

### 9.2 合法转换

| 当前 | 动作 | 目标 | 说明 |
| --- | --- | --- | --- |
| stopped | start | starting | 启动 |
| crashed | start | starting | 允许重新启动 |
| starting | 日志匹配启动完成 / RCON 可连 | running | 正常启动 |
| starting | 进程提前退出 | crashed | 记录退出码 |
| running | stop | stopping | 先 stdin `stop` |
| running | 进程意外退出 | crashed | 非预期退出 |
| stopping | 进程退出 | stopped | 正常或强杀完成 |
| stopping | 超时 | stopping → 强杀 → stopped | 审计标记强制停止 |
| orphaned | stop | stopping | 通过 RCON 发送 `stop` |
| orphaned | kill | stopped | 强制结束进程树 |
| orphaned | RCON 失联且进程仍在 | unknown | 提示管理员 |
| unknown | mark-stopped | stopped | 管理员确认进程已不存在 |
| unknown | kill | stopped | 强制结束 |
| 任意 | 面板重启 | 见 9.4 | 恢复探测 |

### 9.3 启动流程

1. 校验实例状态必须是 `stopped` 或 `crashed`，否则返回 `409 INVALID_STATE`。
2. 校验 `root_path` 仍然存在、可读、可写。
3. 检查 `eula.txt`：
   - 文件存在且 `eula=false` → 返回 `409 EULA_NOT_ACCEPTED`，前端跳转配置页提供“接受 EULA”按钮；
   - 文件不存在 → 允许启动，但前端提示首次启动可能会自动生成并退出。
4. 校验 Java：
   - 优先使用 `java_path`；否则用 `JAVA_HOME/bin/java`；否则 PATH 中的 `java`；
   - 执行 `java -version`，失败返回 `409 JAVA_NOT_FOUND`；
   - 不强制版本匹配，只在界面提示当前 Java 主版本。
5. 校验端口：
   - 从 `server.properties` 读取 `server-port`（默认 25565）和 `enable-rcon`/`rcon.port`；
   - 尝试绑定监听测试；被占用返回 `409 PORT_IN_USE`，并给出端口号。
6. 状态改为 `starting`，记录 `last_pid`、`last_started_at`、`last_state`，广播状态事件。
7. 以 `cwd=root_path` 启动命令：
   - Windows：`cmd.exe /d /s /c "<start_command>"`，`windowsHide: true`；
   - POSIX：`/bin/sh -c "<start_command>"`，`detached: true`，形成独立进程组；
   - 命令只来自管理员，不拼接其他用户输入；界面明确提示该命令以面板进程权限执行。
8. 合并 stdout/stderr，按 `log_encoding` 解码，剥离 ANSI 转义，按行缓冲，写入环形缓冲并广播。
9. 启动完成判定，满足任一条件：
   - 新日志行匹配 `/Done \(|For help, type "help"|Listening on \//i`；
   - RCON 连接并成功执行 `list`；
   - 进程存活超过 300 秒且状态仍为 `starting`，标记 `running` 并记录警告“未检测到启动完成标记”。
10. 进程在进入 `running` 之前退出 → `crashed`，记录退出码和最后 200 行日志。

启动失败识别：日志中出现 `Failed to load eula.txt`、`Address already in use`、`UnsupportedClassVersionError`、`Java heap space` 时，在状态事件中附带可读提示；不自动修改文件。

### 9.4 面板重启后的恢复

面板启动时对每个实例执行：

1. 若 `last_state` 是 `stopped`，直接保持。
2. 若有 `last_pid`：
   - `process.kill(pid, 0)` 判断存活；
   - 用 `systeminformation.processes()` 校验该 PID 的命令行包含实例根路径，避免 PID 复用；
   - 存活且命令行匹配 → 尝试 RCON `list`：
     - 成功 → `orphaned`，广播状态和提示；
     - 失败 → `unknown`，提示可通过强制结束或标记已停止处理。
   - 存活但无法读取命令行 → 尝试 RCON `list`：
     - 成功 → `orphaned`；
     - 失败 → `unknown`。
   - 不存活或命令行明确不匹配：
     - 若 `last_state` 是 `running`、`starting` 或 `stopping` → 标记 `crashed`，错误信息为“面板重启后进程已不存在”；
     - 否则标记 `stopped`。
3. 若没有 `last_pid`：
   - `last_state` 是 `crashed` 或 `unknown` → 保持不变，等待管理员处理；
   - `last_state` 是 `starting`、`running`、`stopping` 或 `orphaned` → 标记 `crashed`，错误信息为“面板重启后进程记录丢失”。
4. 启动顺序：先执行第 12.6 节的备份中断恢复，再执行本节的实例状态恢复；若发现非空的 `.mcpanel-tmp/rollback-*`，最终状态以 `unknown` 为准。
5. 恢复过程中不自动杀进程，不自动启动服务器。

`orphaned` 状态下的操作：

- 停止 → RCON 发送 `stop`，轮询进程是否退出（最多 60 秒），成功 → `stopped`；
- 强制结束 → 结束进程树 → `stopped`；
- 备份 → 允许（RCON 可用时走严格备份）；
- 启动 → 拒绝，提示“进程仍在运行，请先停止”；
- 控制台 → 只读，显示提示“控制台未接管，可通过 RCON 发送命令”；
- 发送命令 → 走 RCON。

### 9.5 停止与强杀

- 停止：
  1. 状态改 `stopping`；
  2. 向 stdin 写入 `stop\n`；
  3. 等待进程退出，最多 `stop_timeout_sec` 秒；
  4. 正常退出 → `stopped`；超时 → 强制结束进程树，审计 `instance.force_stop`，状态 `stopped`，`last_error` 记录超时。
- 强制结束：
  - Windows：`taskkill /PID <pid> /T /F`；
  - POSIX：向进程组发送 `SIGKILL`（`process.kill(-pid, 'SIGKILL')`）；
  - 失败返回 `500 KILL_FAILED`，保留 `unknown`。
- 停止过程中不允许再次启动；返回 `409 OPERATION_IN_PROGRESS`。

### 9.6 面板退出

- 收到 `SIGINT`/`SIGTERM`：停止接受新请求，关闭 WebSocket，停止调度器，关闭数据库；
- **不**向 Minecraft 进程发送停止命令；
- 写入各实例当前状态和 PID，供下次启动恢复探测；
- 文档明确提示：直接关面板不会关服。

### 9.7 控制台缓冲

- 每个实例内存保留最近 5000 行，结构：`{seq, ts, stream, level, text}`；
- 级别识别：`INFO`、`WARN`、`ERROR`，RCON 命令额外标记；
- 缓冲为空时（面板刚启动），首次订阅控制台从 `logs/latest.log` 尾部读取最近 64 KB 并填充历史；
- 日志文件由 Minecraft 自己轮转，面板不复制全量日志；
- “下载日志”读取 `logs/latest.log` 原文件。

## 10. RCON 与玩家管理

### 10.1 配置来源

从 `server.properties` 读取：

- `enable-rcon`；
- `rcon.port`（默认 25575）；
- `rcon.password`；
- `server-ip`（用于推导 RCON 主机）。

主机推导：

- 实例设置了 `rcon_host` → 使用该值；
- `server-ip` 为空或 `0.0.0.0` → `127.0.0.1`；
- `server-ip` 是具体地址 → 使用该地址；
- 无法推导 → `127.0.0.1` 并在界面提示。

密码不写入数据库，不进审计详情，不在日志中输出。

### 10.2 连接与状态

每实例一个惰性连接，状态：

- `disabled`：`enable-rcon=false`；
- `auth_failed`：密码错误或为空；
- `unreachable`：连接拒绝/超时；
- `connected`：`list` 成功；
- `disconnected`：曾经连上，当前断开。

连接超时 5 秒；失败后指数退避重连，最长 30 秒一次。配置页保存 properties 后使连接缓存失效。

### 10.3 一键启用 RCON

配置页提供“启用 RCON”操作：

1. 确认弹窗，说明需要重启服务器；
2. 生成 16 位随机密码（大小写字母+数字）；
3. 保留注释和顺序，写入：
   - `enable-rcon=true`
   - `rcon.port=<当前值或 25575>`
   - `rcon.password=<随机密码>`
   - 若目标端口已被其他受管实例配置占用，依次尝试 25575–25584；仍冲突则返回 `409 PORT_IN_USE`，要求用户先改端口；
4. 显示密码并提供复制按钮；
5. 记录审计 `instance.rcon_enable`，不记录密码明文；
6. 提示重启后生效。

### 10.4 在线玩家

通过 RCON 执行 `list`，解析规则：

- 优先匹配 `There are (\d+) of a max of (\d+) players online:?(.*)`；
- 兼容 `There are (\d+)/(\d+) players online:?(.*)`；
- 冒号后的内容按逗号分割，去空白；
- 玩家名按 `^[A-Za-z0-9_]{1,16}$` 过滤；
- 解析失败时返回在线列表为空，并附 `warning` 字段，不抛 500。

刷新：

- 控制台页/右侧面板订阅时每 15 秒刷新一次；
- 玩家页打开时每 10 秒刷新一次；
- 执行玩家操作后立即刷新。

### 10.5 玩家操作

全部通过 RCON 执行，参数在服务端用固定模板拼接，不接受任意命令注入：

| 操作 | 命令 |
| --- | --- |
| OP | `op <player>` |
| 取消 OP | `deop <player>` |
| 加白名单 | `whitelist add <player>` |
| 移出白名单 | `whitelist remove <player>` |
| 踢出 | `kick <player> <reason>` |
| 封禁 | `ban <player> <reason>` |
| 解封 | `pardon <player>` |
| 切换模式 | `gamemode <survival\|creative\|adventure\|spectator> <player>` |
| 广播 | `say <message>` |
| 白名单开关 | `whitelist on` / `whitelist off` |

校验：

- 玩家名必须匹配 `^[A-Za-z0-9_]{1,16}$`；
- 原因最多 200 字符，去除换行；
- 玩家名不存在时把 RCON 返回的错误原样显示，不视为服务器错误；
- 所有操作记审计，包含操作类型、玩家名、原因（如有），不包含 RCON 密码。

停止状态下的玩家页：

- 在线列表为空，显示“服务器未运行”；
- `whitelist.json`、`ops.json`、`banned-players.json`、`banned-ips.json` 只读展示条目和数量；
- 修改操作要求先启动服务器，避免离线 UUID 解析错误。

### 10.6 命令发送

- 控制台输入走进程 stdin（受托管时），每行一条命令，追加 `\n`；
- `orphaned` 状态走 RCON；
- 任意命令属于管理员能力，记审计 `console.command`，detail 包含命令原文；
- 限流：每实例 30 条/分钟，超出返回 `429 COMMAND_RATE_LIMITED`。

## 11. 文件与配置管理

### 11.1 路径沙箱

所有文件接口接受 POSIX 风格的相对路径，内部转换为平台路径。

校验顺序：

1. `root_path` 必须是已存在的目录；注册时对根目录做一次 `realpath`，保存真实路径（根目录本身是符号链接时按真实路径纳管）；拒绝 `C:\`、`/` 这类文件系统根，拒绝用户主目录本身。
2. `path.resolve(root, rel)` 后必须是 root 本身或以 `root + path.sep` 开头；Windows 下大小写不敏感比较。
3. 从 root 到目标逐级 `lstat`，任何一级是符号链接/junction 都拒绝操作（读、写、删、改名、解压均如此）。
4. 不存在的目标文件，校验其父目录的真实路径仍在 root 内。
5. 实例根目录与面板 `data/` 不得互相包含：
   - 实例根不能在 `data/` 内；
   - `data/` 不能在实例根内；
   - 实例根不能与另一个实例根重叠（嵌套）。

失败返回：

- 越界 → `403 PATH_OUTSIDE_ROOT`；
- 符号链接 → `403 SYMLINK_NOT_ALLOWED`；
- 根目录非法 → `400 INVALID_ROOT`；
- 重叠 → `409 ROOT_OVERLAPS`。

### 11.2 文件列表与操作

接口能力：

- 列出目录：名称、类型、大小、mtime、是否符号链接、是否可编辑；
- 读取文本：最大 2 MB，含 NUL 字节视为二进制，不允许编辑器打开；
- 保存文本：请求带 `expectedMtime`；文件当前 mtime 不一致返回 `409 MTIME_CONFLICT`，前端提示“文件已被外部修改”，可选择重新加载或强制覆盖；
- 上传：multipart 流式写入 `.upload-<uuid>.tmp`，完成后原子改名；单文件上限由 `MAX_UPLOAD_MB` 控制，默认 1024；
- 下载：流式返回，`Content-Disposition: attachment`；
- 新建目录、重命名、删除；
- 删除目录必须显式 `recursive=true`，前端要求输入目录名确认；
- 解压：只允许 zip，校验 zip-slip、绝对路径、符号链接条目、条目数上限 100,000、解压后总大小上限 10 GB；
- 文件编辑器隐藏 `.mcpanel-tmp/`，备份也排除该目录。

### 11.3 模组管理

第一版只做文件层操作，不解析模组元数据：

- 在 `mods/` 目录下，`.jar` 可“禁用”为 `.jar.disabled`，也可反向启用；
- 非 `mods/` 目录不提供该快捷操作；
- 上传 `.jar` 到 `mods/` 即安装；
- 删除模组前提示“删除后无法从面板恢复，除非备份包含 mods”。

### 11.4 `server.properties` 编辑

- 文件编码按 UTF-8 处理；读取失败时提示可能是非 UTF-8 文件，建议用原始编辑器或手工处理；
- 解析时保留注释、空行和键顺序；
- 修改某个键时，更新文件中**所有**同名键的值，避免重复键导致歧义；不存在则追加到文件末尾；
- 保留原始换行风格（CRLF/LF）；
- 保存带 `expectedMtime`，冲突规则同上；
- 检测重复键并在界面提示；
- 表单覆盖常见字段，未知字段只在原始编辑器中显示。

表单字段分组：

| 分组 | 字段 |
| --- | --- |
| 基础 | `motd`、`server-port`、`max-players`、`online-mode`、`white-list`、`enforce-whitelist` |
| 玩法 | `gamemode`、`difficulty`、`hardcore`、`pvp`、`allow-flight`、`spawn-protection`、`force-gamemode` |
| 性能 | `view-distance`、`simulation-distance`、`max-tick-time`、`entity-broadcast-range-percentage` |
| 网络 | `server-ip`、`enable-rcon`、`rcon.port`、`rcon.password`、`enable-query`、`query.port` |
| 世界 | `level-name`、`level-seed`、`level-type`、`allow-nether`、`enable-command-block`、`op-permission-level` |

类型与校验：

- 布尔：`true/false`；
- 整数：端口 1–65535，`max-players` 1–10000，视距 2–32，模拟距离 2–32；
- 枚举：`gamemode`、`difficulty`、`level-type` 使用下拉；
- 密码字段默认掩码，可显示和复制；
- 保存后提示“多数配置需要重启服务器生效”，提供跳转到顶部重启按钮。

### 11.5 EULA

- 读取 `eula.txt`；
- 未接受时在启动拦截和概览页显示警告；
- 提供“接受 EULA”按钮，二次确认后写入/更新 `eula=true`；
- 记录审计 `instance.eula_accept`；
- 绝不在用户不知情时自动接受。

## 12. 备份与恢复

### 12.1 备份范围

默认包含（存在才打包）：

- 存档目录：`level-name`（默认 `world`）、`<level-name>_nether`、`<level-name>_the_end`；
- `server.properties`、`eula.txt`；
- `whitelist.json`、`ops.json`、`banned-players.json`、`banned-ips.json`；
- `config/`（当 `backup_include_config=1`）；
- `defaultconfigs/`（存在且 `backup_include_config=1`）；
- `backup_extra_paths` 中的相对路径（最多 20 个，必须在实例根内）。

可选：

- `mods/`（`backup_include_mods=1`）。

排除：

- `logs/`、`crash-reports/`、`cache/`、`libraries/`、`.mcpanel-tmp/`；
- 面板数据目录。

如果存档目录、配置文件都不存在，拒绝创建备份并提示“没有可备份的内容”。

### 12.2 一致性策略（严格）

- **服务器已停止**：直接冷备份。
- **服务器运行中（`running` 或 `orphaned`）且 RCON 已连接**：
  1. RCON 执行 `save-off`；
  2. RCON 执行 `save-all flush`；
  3. 从 `logs/latest.log` 尾部开始监听，等待新增行匹配 `/Saved the game|Saved the world/i`，最长 60 秒；受托管时同时观察控制台输出；
  4. 匹配成功 → 开始打包；
  5. 日志文件不存在、不可读、超时或命令失败 → 中止备份，`finally` 中执行 `save-on`，记录失败原因；
  6. 打包结束（无论成败）→ RCON 执行 `save-on`。
- **服务器运行中但 RCON 不可用**：拒绝备份，返回 `409 BACKUP_REQUIRES_STOP_OR_RCON`；前端提供“停服后备份”按钮。
- **`starting` / `stopping` / `unknown`**：拒绝，返回 `409 INVALID_STATE`。
- 不提供“尽力备份”选项。

### 12.3 创建流程

1. 获取实例任务锁；已有备份/恢复 → `409 BACKUP_BUSY`。
2. 计算备份源并统计总大小；检查磁盘剩余空间 ≥ 源大小的 1.5 倍，否则拒绝 `507 INSUFFICIENT_DISK`。
3. 写 `backups` 记录，状态 `creating`，广播任务开始。
4. 运行中先执行严格冻结流程。
5. 打包到 `data/tmp/backup-<uuid>.zip.part`：
   - `archiver` 流式压缩；
   - 在 zip 根写入 `manifest.json`；
   - 进度按已处理字节广播。
6. 完成后关闭流，原子改名为 `data/backups/<instanceId>/<YYYYMMDD-HHmmss>-<kind>-<shortid>.zip`。
7. 更新记录：`ready`、大小、manifest；广播任务完成。
8. 执行保留策略；失败不影响本次备份成功，只记面板日志。
9. 任何异常：状态 `failed`，记录错误，清理 `.part` 和临时目录；运行中的实例保证执行 `save-on`。

`manifest.json` 字段：

```json
{
  "schemaVersion": 1,
  "panelVersion": "0.1.0",
  "instanceName": "生存服",
  "createdAt": "2026-10-23T04:00:00.000Z",
  "sources": ["world", "world_nether", "server.properties", "config"],
  "fileCount": 12034,
  "totalBytes": 812345678
}
```

### 12.4 保留策略

- 每个实例按 `backup_keep` 保留最近 N 个（默认 10，范围 1–100）；
- 手动、定时、`pre_restore` 备份共同计数；
- 最新一个 `pre_restore` 备份即使超出数量也保留，确保至少有一份恢复前安全副本；
- 删除顺序按 `created_at` 从旧到新；
- 删除只作用于 `ready` 状态的记录和对应文件，不删除正在创建或恢复中的备份；
- 保留策略失败只记日志，不回滚已完成的备份。

### 12.5 恢复流程

恢复要求实例状态为 `stopped`；否则返回 `409 RESTORE_REQUIRES_STOP`。

1. 获取实例任务锁。
2. 校验备份存在、状态 `ready`、zip 可读、manifest schema 版本支持。
3. 将源备份状态改为 `restoring`，防止保留策略在恢复期间删除它。
4. **先做一次冷备份**（`kind=pre_restore`）；失败则把源备份状态改回 `ready` 并中止恢复。
5. 在实例根创建 `.mcpanel-tmp/restore-<uuid>/`，解压到该目录：
   - 校验 zip-slip、绝对路径、符号链接条目；
   - 条目数上限 1,000,000；
   - 解压后总大小不得超过 `max(manifest.totalBytes × 1.1, 2 GB)`；
   - 解压前检查实例根所在磁盘剩余空间 ≥ `manifest.totalBytes × 1.2`；
   - 校验 manifest 中声明的源都存在。
6. 将实例中现有的目标路径移动到 `.mcpanel-tmp/rollback-<uuid>/`（同一磁盘卷，保证 rename 成功）。
7. 将解压出的目标路径移动到实例根对应位置。
8. 任一步失败：
   - 尝试把 `rollback` 中的路径移回；
   - 回滚失败则保留目录并提示安全备份位置；
   - 源备份状态改回 `ready`；
   - 记录失败原因，写审计 `backup.restore_failed`。
9. 成功后：
   - 删除 `.mcpanel-tmp/restore-*`、`.mcpanel-tmp/rollback-*`；
   - 源备份状态改回 `ready`，仍可下载或再次恢复；
   - 写审计 `backup.restore`；
   - 状态保持 `stopped`，由管理员手动启动。

恢复不会删除备份中未包含的路径。例如备份未包含 `mods/`，恢复后当前的 `mods/` 原样保留。

### 12.6 备份中断恢复

- 面板启动时扫描 `status='creating'` 的备份记录，标记 `failed`，错误“面板重启导致备份中断”；
- 扫描 `status='restoring'` 的备份记录，改回 `ready`，并记录“面板重启导致恢复中断”；已产生的 `pre_restore` 备份保留；
- 清理 `data/tmp` 下超过 24 小时的 `.part`；
- 对运行中且 RCON 可连的实例发送一次 `save-on`，防止上次备份中断后存档一直处于关闭状态；
- 恢复中断时按以下规则处理 `.mcpanel-tmp`：
  - 存在非空 `.mcpanel-tmp/rollback-*`：不删除，保留现场，将该实例标记为 `unknown`，`last_error` 写明目录路径；管理员处理后可执行“标记为已停止”；
  - 不存在非空 `rollback-*`：删除所有 `restore-*` 和空的 `rollback-*` 目录；
- 概览页对 `unknown` 且存在 rollback 的实例提供“清理恢复残留”操作：要求输入实例名确认，删除 `.mcpanel-tmp`，记审计 `instance.cleanup_restore`；只允许在 `stopped`/`unknown`/`crashed` 状态执行；
- 文件浏览与备份均排除 `.mcpanel-tmp/`。

## 13. 定时任务

### 13.1 动作

| 动作 | 行为 |
| --- | --- |
| `backup` | 严格执行第 12 节流程；不满足条件则本次运行失败 |
| `start` | 状态 `stopped`/`crashed` 时启动；`running`/`orphaned` 时跳过 |
| `stop` | 状态 `running`/`orphaned` 时停止；已停止则跳过 |
| `restart` | `running`/`orphaned`→停止后启动；`stopped`/`crashed`→直接启动；`starting`/`stopping`/`unknown`→失败 |
| `command` | 受托管时通过控制台 stdin，`orphaned` 时通过 RCON；未运行→失败 |
| `broadcast` | 受托管时通过控制台 stdin 执行 `say <message>`，`orphaned` 时通过 RCON；未运行→失败 |

### 13.2 调度规则

- 标准 5 段 cron：分 时 日 月 周；
- 每个计划独立的 IANA 时区，默认取 `default_timezone`；
- 保存时用 `croner` 校验并计算未来 3 次运行时间，非法表达式返回 `400 INVALID_CRON`；
- 任务触发时获取实例锁；如果上一个同名计划仍在运行，记录 `skipped`；
- 面板离线期间错过的任务**不补跑**；
- 修改 cron、时区、启用状态后立即重排；
- 删除实例时级联删除计划和运行记录。

### 13.3 运行记录

- 每次触发写 `schedule_runs`，状态从 `running` 开始；
- 成功、失败、跳过都写结束时间和消息；
- 每个计划保留最近 100 条；
- 手动“立即运行”同样写入记录，`trigger='manual'`；
- 计划列表显示 `next_run_at` 和最近一次结果。

## 14. 监控与仪表盘

### 14.1 采集指标

系统：

- CPU 使用率；
- 内存已用/总量；
- `data/` 所在磁盘剩余；
- 系统运行时长；
- 节点平台、Node.js 版本。

实例：

- 状态、PID、运行时长；
- 进程 CPU（单核口径，可能超过 100%）、RSS 内存；
- 在线人数与上限（RCON 可用时）；
- 实例根目录所在磁盘剩余；
- 最近一次备份时间、结果；
- RCON 状态。

### 14.2 采样与推送

- 有客户端订阅时每 3 秒采样一次；
- 无订阅超过 30 秒后停止采样；
- 每个实例在内存中保留最近 60 个样本用于 sparkline，面板重启清空；
- 不做长期指标入库；
- `orphaned` 实例在 PID 校验通过时也采集进程指标；
- 玩家数在控制台/仪表盘订阅时每 15 秒刷新。

### 14.3 仪表盘

- 系统概览卡片：CPU、内存、磁盘、节点信息；
- 实例卡片/列表：名称、状态、在线人数、CPU sparkline、内存、最近备份、启动/停止/打开控制台；
- 最近审计活动 10 条；
- 警告区：
  - `unknown` / `orphaned` 实例；
  - RCON 未启用；
  - 超过 7 天没有成功备份；
  - 磁盘剩余低于 10%；
  - 最近 24 小时有失败的计划任务；
  - EULA 未接受。
- 空状态：引导“纳管第一个实例”。

### 14.4 实例概览页

- 状态、PID、运行时长；
- CPU/内存 sparkline、在线玩家；
- RCON 状态、Java 版本；
- 最近备份、下次计划任务；
- 最近 20 行控制台；
- 快捷操作：启动、停止、重启、备份、打开控制台。

## 15. 认证、授权与审计

### 15.1 首次初始化

- 当 `users` 表为空，所有页面重定向到 `/setup`；
- `/api/auth/status` 返回 `{ setupRequired: true, authenticated: false }`；
- 初始化表单：用户名（默认 `admin`，3–32 字符）、密码（至少 12 字符）、确认密码；
- 创建成功后自动登录并写审计 `setup.complete`；
- 一旦存在用户，`POST /api/auth/setup` 永远返回 `403 SETUP_COMPLETED`；
- 如果 `PANEL_HOST` 不是回环地址且尚未初始化，**拒绝启动**，要求先在本机完成初始化，避免公网被抢注管理员。

### 15.2 登录会话

- 密码使用 argon2id 哈希；
- 登录失败统一返回“用户名或密码错误”，不暴露账号是否存在；
- 登录限流：每 IP 每分钟 5 次；连续失败 10 次锁定 15 分钟；
- 会话 token 32 字节随机值，Cookie 为 `mcpanel_session`：
  - `httpOnly`；
  - `SameSite=Lax`；
  - `Secure` 在 `COOKIE_SECURE=true` 时启用；
  - 有效期 7 天，固定过期，不做滑动续期；
- 数据库只存 token 的 SHA-256；
- 退出登录删除当前会话；
- 修改密码后删除该用户其他会话；
- 每小时清理过期会话；
- 忘记密码使用 `node scripts/reset-password.mjs <username>` 重置。

### 15.3 CSRF 与 WebSocket 鉴权

- 所有 `POST/PUT/PATCH/DELETE` 要求 `X-CSRF-Token`，由 `@fastify/csrf-protection` 生成并绑定会话；
- 同时校验 `Origin`/`Referer` 与面板 Host 一致；
- WebSocket 升级时校验登录会话和 `Origin`；未通过直接断开，不进入消息循环；
- 开发环境 Vite 走同源代理，不开启 CORS。

### 15.4 审计

记录以下动作（不记录读取）：

- 认证：`auth.login`、`auth.logout`、`auth.login_failed`、`auth.password_change`、`setup.complete`；
- 实例：`instance.create`、`instance.update`、`instance.delete`、`instance.start`、`instance.stop`、`instance.force_stop`、`instance.kill`、`instance.crash`、`instance.recover_orphan`、`instance.mark_stopped`、`instance.cleanup_restore`；
- 控制台：`console.command`；
- 文件：`file.write`、`file.upload`、`file.rename`、`file.delete`、`file.unzip`、`file.mkdir`、`file.mod_toggle`；
- 配置：`config.update`、`instance.eula_accept`、`instance.rcon_enable`；
- 玩家：`player.op`、`player.deop`、`player.whitelist_add`、`player.whitelist_remove`、`player.kick`、`player.ban`、`player.pardon`、`player.gamemode`、`player.broadcast`、`player.whitelist_toggle`；
- 备份：`backup.create`、`backup.delete`、`backup.download`、`backup.restore`；
- 计划：`schedule.create`、`schedule.update`、`schedule.delete`、`schedule.run`；
- 设置：`settings.update`。

审计详情会做敏感字段清洗，剔除 `password`、`rcon.password`、`token`、`secret` 等键。审计页支持按动作、实例、时间范围筛选和分页。

## 16. API 规格

### 16.1 约定

- Base：`/api`；
- JSON 请求/响应，文件上传和下载除外；
- 认证：会话 Cookie；
- 修改请求：`X-CSRF-Token`；
- ID 为 UUID 字符串；时间为 ISO 8601 UTC；
- 分页：`page`（从 1 开始）、`pageSize`（默认 20，最大 100）；
- 异步动作返回 `202` 和任务信息，进度通过 WebSocket 推送；
- 错误统一格式：

```json
{
  "error": {
    "code": "INVALID_STATE",
    "message": "实例正在停止，无法启动",
    "details": { "state": "stopping" }
  }
}
```

### 16.2 错误码

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `AUTH_REQUIRED` | 401 | 未登录/会话过期 |
| `INVALID_CREDENTIALS` | 401 | 用户名或密码错误 |
| `LOGIN_RATE_LIMITED` | 429 | 登录尝试过多 |
| `SETUP_COMPLETED` | 403 | 已完成初始化 |
| `FORBIDDEN` | 403 | 无权限/来源校验失败 |
| `CSRF_INVALID` | 403 | CSRF token 缺失或无效 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `VALIDATION_ERROR` | 400 | 参数校验失败，details 含字段错误 |
| `INVALID_STATE` | 409 | 当前状态不允许该操作 |
| `OPERATION_IN_PROGRESS` | 409 | 实例已有操作在跑 |
| `INVALID_ROOT` | 400 | 实例目录非法 |
| `ROOT_OVERLAPS` | 409 | 实例目录与面板数据或其他实例重叠 |
| `PATH_OUTSIDE_ROOT` | 403 | 路径越界 |
| `SYMLINK_NOT_ALLOWED` | 403 | 路径包含符号链接 |
| `FILE_TOO_LARGE` | 413 | 文件或上传超过限制 |
| `MTIME_CONFLICT` | 409 | 文件已被外部修改 |
| `UNSUPPORTED_FILE` | 415 | 二进制/不支持编辑的文件 |
| `ZIP_INVALID` | 400 | 压缩包非法或包含不安全条目 |
| `JAVA_NOT_FOUND` | 409 | 找不到可用 Java |
| `EULA_NOT_ACCEPTED` | 409 | 尚未接受 EULA |
| `PORT_IN_USE` | 409 | 端口被占用 |
| `RCON_DISABLED` | 409 | 未启用 RCON |
| `RCON_UNAVAILABLE` | 409 | RCON 连不上/认证失败 |
| `BACKUP_BUSY` | 409 | 已有备份/恢复任务 |
| `BACKUP_REQUIRES_STOP_OR_RCON` | 409 | 严格备份条件不满足 |
| `RESTORE_REQUIRES_STOP` | 409 | 恢复前必须停服 |
| `INSUFFICIENT_DISK` | 507 | 磁盘空间不足 |
| `INVALID_CRON` | 400 | cron 表达式非法 |
| `COMMAND_RATE_LIMITED` | 429 | 命令发送过快 |
| `KILL_FAILED` | 500 | 强制结束失败 |
| `INTERNAL` | 500 | 未预期错误 |

### 16.3 认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/auth/status` | 返回 `{ setupRequired, authenticated, user }` |
| POST | `/api/auth/setup` | `{ username, password }`，仅首次可用 |
| POST | `/api/auth/login` | `{ username, password }` |
| POST | `/api/auth/logout` | 删除当前会话 |
| GET | `/api/auth/me` | 当前用户 |
| POST | `/api/auth/password` | `{ currentPassword, newPassword }` |
| GET | `/api/auth/csrf` | 获取/刷新 CSRF token |

### 16.4 系统与设置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 无需认证，`{ ok, version }` |
| GET | `/api/system/overview` | 系统指标、节点信息、磁盘 |
| GET | `/api/settings` | 面板设置 |
| PATCH | `/api/settings` | 修改 `panel_name`、`default_timezone`、`audit_retention_days` |
| GET | `/api/audit` | 审计分页查询 |

### 16.5 实例

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/instances` | 实例列表 + 运行时摘要 |
| POST | `/api/instances/probe` | `{ rootPath }`，探测目录、启动脚本、Java、properties 摘要、警告；不落库 |
| POST | `/api/instances` | 创建实例 |
| GET | `/api/instances/:id` | 详情 + 运行时 + RCON 状态 |
| PATCH | `/api/instances/:id` | 修改名称、启动命令、Java、超时、备份设置、日志编码、RCON 主机 |
| DELETE | `/api/instances/:id` | 删除注册（要求已停止；不删除服务器目录） |
| GET | `/api/instances/:id/status` | 状态快照 |
| POST | `/api/instances/:id/actions/start` | 202 |
| POST | `/api/instances/:id/actions/stop` | 202 |
| POST | `/api/instances/:id/actions/restart` | 202 |
| POST | `/api/instances/:id/actions/kill` | 202 |
| POST | `/api/instances/:id/actions/mark-stopped` | 仅 `unknown`/`crashed`，确认进程已结束 |
| POST | `/api/instances/:id/actions/cleanup-restore` | 清理恢复残留，要求输入实例名 |
| GET | `/api/instances/:id/logs` | 最近 N 行（默认 200，最大 2000） |
| POST | `/api/instances/:id/console/command` | `{ command }` |

`POST /api/instances/probe` 返回：

```json
{
  "rootPath": "D:\\servers\\survival",
  "valid": true,
  "detected": {
    "startScripts": ["run.bat"],
    "serverJars": ["fabric-server-launch.jar"],
    "levelName": "world",
    "serverPort": 25565,
    "enableRcon": true,
    "rconPort": 25575,
    "onlineMode": true,
    "hasMods": true,
    "hasConfig": true,
    "eula": false
  },
  "java": { "path": "C:\\Program Files\\Java\\jdk-21\\bin\\java", "major": 21 },
  "suggestedStartCommand": "run.bat",
  "warnings": [
    { "code": "EULA_NOT_ACCEPTED", "message": "eula.txt 尚未接受" },
    { "code": "RCON_PASSWORD_EMPTY", "message": "RCON 已启用但密码为空" }
  ]
}
```

`POST /api/instances` 请求：

```json
{
  "name": "生存服",
  "rootPath": "D:\\servers\\survival",
  "startCommand": "run.bat",
  "javaPath": null,
  "stopTimeoutSec": 30,
  "logEncoding": "utf-8",
  "backupKeep": 10,
  "backupIncludeMods": false,
  "backupIncludeConfig": true,
  "backupExtraPaths": []
}
```

删除实例：

- 仅允许 `stopped`/`crashed`，且没有进行中的备份或恢复任务；
- 若实例根存在非空 `.mcpanel-tmp/rollback-*`，拒绝删除，要求先按 12.6 节处理；
- 请求体 `{ "confirmName": "生存服" }`；
- 删除数据库记录、计划、备份记录和备份文件；
- **不删除**实例根目录；
- 审计保留。

### 16.6 玩家与 RCON

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/instances/:id/players` | 在线玩家、上限、RCON 状态 |
| GET | `/api/instances/:id/players/lists` | 白名单/OP/封禁只读列表 |
| POST | `/api/instances/:id/players/actions` | 见下 |
| POST | `/api/instances/:id/rcon/test` | 测试连接 |
| POST | `/api/instances/:id/rcon/enable` | 生成并写入 RCON 配置 |

玩家动作请求：

```json
{
  "action": "kick",
  "player": "Steve",
  "reason": "测试"
}
```

`action` 取值：`op`、`deop`、`whitelist_add`、`whitelist_remove`、`kick`、`ban`、`pardon`、`gamemode`、`broadcast`、`whitelist_on`、`whitelist_off`。`gamemode` 额外需要 `mode`；`broadcast` 使用 `message` 而不是 `player`。

### 16.7 文件与配置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/instances/:id/files?path=/` | 目录列表 |
| GET | `/api/instances/:id/files/content?path=/config/x.yml` | 读取文本，返回 `{ content, mtime, eol }` |
| PUT | `/api/instances/:id/files/content` | `{ path, content, expectedMtime }` |
| POST | `/api/instances/:id/files/upload` | multipart：`path`、`file` |
| GET | `/api/instances/:id/files/download?path=/mods/x.jar` | 下载 |
| POST | `/api/instances/:id/files/mkdir` | `{ path }` |
| POST | `/api/instances/:id/files/rename` | `{ path, newName }` |
| DELETE | `/api/instances/:id/files` | `{ path, recursive }` |
| POST | `/api/instances/:id/files/unzip` | `{ path, targetDir }` |
| POST | `/api/instances/:id/files/mods/toggle` | `{ path }`，仅 `mods/` 下 `.jar`/`.jar.disabled` |
| GET | `/api/instances/:id/config/properties` | `{ entries, raw, mtime, duplicates }` |
| PUT | `/api/instances/:id/config/properties` | `{ changes, expectedMtime }` |
| POST | `/api/instances/:id/config/eula` | `{ accept: true }` |

### 16.8 备份

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/instances/:id/backups` | 备份列表 |
| POST | `/api/instances/:id/backups` | 创建，202，返回 `{ taskId, backupId }` |
| DELETE | `/api/instances/:id/backups/:backupId` | 删除备份 |
| POST | `/api/instances/:id/backups/:backupId/restore` | 恢复，202，返回 `{ taskId }` |
| GET | `/api/instances/:id/backups/:backupId/download` | 下载 zip |
| GET | `/api/instances/:id/backups/:backupId/manifest` | 返回 manifest |

删除与恢复只接受状态为 `ready` 的备份；`creating` 和 `restoring` 状态返回 `409 BACKUP_BUSY`。

### 16.9 计划任务

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/instances/:id/schedules` | 计划列表，含 nextRunAt |
| POST | `/api/instances/:id/schedules` | 创建 |
| PATCH | `/api/instances/:id/schedules/:scheduleId` | 修改 |
| DELETE | `/api/instances/:id/schedules/:scheduleId` | 删除 |
| POST | `/api/instances/:id/schedules/:scheduleId/run` | 立即运行 |
| GET | `/api/instances/:id/schedules/:scheduleId/runs` | 运行记录，最近 100 条 |

## 17. WebSocket 协议

### 17.1 连接

- 路径：`/api/ws`；
- 升级时校验会话 Cookie 和 Origin；
- 未认证返回 401 并关闭；
- 心跳：客户端每 30 秒发 `ping`，服务端回 `pong`；服务端 70 秒未收到消息断开连接。

### 17.2 客户端消息

```json
{ "type": "subscribe", "channel": "instance:<id>:console", "sinceSeq": 1200 }
{ "type": "unsubscribe", "channel": "instance:<id>:console" }
{ "type": "ping" }
```

频道：

- `instance:<id>:console`
- `instance:<id>:status`
- `instance:<id>:metrics`
- `instance:<id>:players`
- `system:metrics`
- `task:<taskId>`

### 17.3 服务端消息

```json
{ "type": "hello", "channels": [], "serverTime": "2026-10-23T04:00:00.000Z" }
{ "type": "console.snapshot", "channel": "instance:x:console", "lines": [], "lastSeq": 1300, "gap": false }
{ "type": "console.append", "channel": "instance:x:console", "lines": [] }
{ "type": "console.gap", "channel": "instance:x:console", "dropped": 42 }
{ "type": "instance.state", "instanceId": "x", "state": "running", "pid": 1234, "startedAt": "2026-10-23T04:00:00.000Z", "error": null }
{ "type": "metrics.sample", "target": "instance", "instanceId": "x", "ts": "2026-10-23T04:00:00.000Z", "cpu": 12.4, "memBytes": 3435973836, "diskFreeBytes": 45097156608 }
{ "type": "players.update", "instanceId": "x", "online": ["Steve"], "max": 20, "rconStatus": "connected" }
{ "type": "task.progress", "taskId": "t", "kind": "backup", "instanceId": "x", "progress": { "percent": 42, "bytes": 1000, "totalBytes": 2400, "message": "正在压缩 world" } }
{ "type": "task.finished", "taskId": "t", "kind": "backup", "status": "success", "message": "备份完成", "resourceId": "backup-id" }
{ "type": "notification", "level": "warning", "message": "实例进入 orphaned 状态" }
{ "type": "error", "code": "FORBIDDEN", "message": "无权订阅该频道" }
```

控制台行结构：

```json
{ "seq": 1301, "ts": "2026-10-23T04:00:01.000Z", "stream": "stdout", "level": "info", "text": "[Server thread/INFO]: Done (12.4s)!" }
```

### 17.4 重连与缺口

- 控制台每行带递增 `seq`；
- 客户端重连带 `sinceSeq`；
- 若缓冲仍覆盖 `sinceSeq` → 返回增量 `console.append`；
- 否则返回 `console.snapshot` 并标记 `gap: true`，客户端显示“部分历史已丢失”提示；
- 客户端对 `seq` 去重。

### 17.5 背压

- 每个连接维护发送队列；当 `ws.bufferedAmount` 超过 1 MB：
  - 控制台消息丢弃最旧的未发送行；
  - 发送 `console.gap` 告知丢弃数量；
  - 状态、任务完成等关键消息不丢弃；
- 客户端断开后清理订阅和定时器。

## 18. 前端设计

### 18.1 路由

| 路径 | 页面 |
| --- | --- |
| `/setup` | 首次初始化 |
| `/login` | 登录 |
| `/` | 仪表盘 |
| `/instances` | 实例列表/纳管 |
| `/instances/:id` | 重定向到 `/overview` |
| `/instances/:id/overview` | 概览 |
| `/instances/:id/console` | 控制台 |
| `/instances/:id/players` | 玩家 |
| `/instances/:id/files` | 文件 |
| `/instances/:id/config` | 配置 |
| `/instances/:id/backups` | 备份 |
| `/instances/:id/schedules` | 计划 |
| `/instances/:id/settings` | 实例设置 |
| `/audit` | 审计 |
| `/settings` | 面板设置 |

### 18.2 布局

采用已确认的 **A 方案**：

- 左侧固定侧边栏：总览、实例、审计、设置；底部版本号、主题切换、退出登录；
- 实例详情页顶部固定：实例名、状态徽章、启动/停止/重启；
- 实例内页签：概览、控制台、玩家、文件、配置、备份、计划、设置；
- 右侧玩家/快捷操作面板：
  - 是实例详情布局的一部分；
  - 宽屏默认展开，可手动折叠；
  - 在文件、配置、备份、计划页签自动折叠以保留编辑宽度，用户可手动展开；
  - 折叠状态存 `localStorage`；
  - 窄屏（< 1024px）默认折叠，玩家与快捷操作仍可通过“玩家”页签访问；
- 移动端（< 768px）：侧边栏变抽屉，页签横向滚动，控制台输入框固定底部。

### 18.3 视觉系统

- 默认深色主题，可切换浅色/跟随系统；
- 颜色：深色背景近黑绿灰，主色翡翠绿 `#4ade80`，浅色主题主色 `#15803d`；警告琥珀，危险红；
- 边框 1px，卡片圆角 8–10px，不使用大面积渐变和装饰性阴影；
- 字体：系统中文字体（`"Microsoft YaHei"`, `"PingFang SC"`, `"Noto Sans SC"`），控制台使用 `ui-monospace, Consolas, "Courier New", monospace`；
- 不使用 Minecraft 官方纹理、字体或 Logo；品牌图形用 CSS 方块拼出的原创标记；
- 动效克制，尊重 `prefers-reduced-motion`。

### 18.4 组件

- `AppShell`：侧边栏、顶栏、内容区；
- `InstanceLayout`：实例头部、页签、右侧面板；
- `StatusBadge`：状态颜色与文案统一；
- `ConsoleViewer`：虚拟滚动、自动滚动开关、搜索、级别过滤、下载日志；
- `CommandInput`：历史记录（localStorage，最多 100 条）、发送中状态；
- `PlayerList`：本地生成的像素头像（用户名哈希决定颜色/图案），不请求外网；
- `FileBrowser`：面包屑、列表、上传拖拽、右键/操作菜单、确认框；
- `FileEditor`：CodeMirror 6，mtime 冲突对话框；
- `PropertiesForm`：分组表单、原始编辑切换、需要重启提示；
- `BackupList`：状态、大小、创建时间、下载/恢复/删除；
- `ScheduleForm`：cron 预设（每天 04:00、每周日 04:00 等）+ 自定义、时区、未来 3 次运行预览；
- `MetricsSparkline`：Recharts；
- `ConfirmDialog`、`Toasts`、`EmptyState`、`ErrorState`。

### 18.5 状态管理

- TanStack Query 管理 REST 数据：实例列表、详情、文件、备份、计划、审计；
- Zustand 管理实时状态：控制台缓冲、WS 连接状态、当前订阅、任务进度；
- WS 事件除了更新 Zustand，也触发相关 Query 的失效/局部更新；
- 登录失效（401）统一跳转 `/login`，保留原始路径；
- 所有破坏性操作使用确认框，删除/恢复要求输入名称或勾选确认。

### 18.6 控制台性能

- 最多渲染 5000 行，使用 `@tanstack/react-virtual` 虚拟滚动；
- 自动滚动仅在用户位于底部时启用；向上滚动自动暂停并显示“回到最新”按钮；
- 搜索和级别过滤在客户端对缓冲执行；
- 日志行渲染为文本节点，不使用 `dangerouslySetInnerHTML`；
- 下载日志走后端接口，不把全量日志塞进前端。

### 18.7 错误与空状态

- API 错误统一映射为中文提示，展示 `error.code` 便于排障；
- 实例未纳管：显示引导卡片；
- 服务器停止：控制台显示“服务器未运行”，命令输入禁用；
- RCON 未启用：玩家页显示启用引导和重启提示；
- 备份条件不满足：明确显示原因和“停服后备份”入口；
- 文件二进制/过大：显示下载按钮而不是编辑器；
- 任务失败：toast + 备份/计划列表中的错误详情。

### 18.8 可访问性

- 所有交互元素可键盘操作，焦点可见；
- 状态不只靠颜色，配文字/图标；
- 对比度满足 WCAG AA；
- 确认框焦点陷阱和 Esc 关闭；
- 动态任务结果使用 `aria-live="polite"`，错误使用 `role="alert"`。

## 19. 安全设计

- 默认 `PANEL_HOST=127.0.0.1`；非回环绑定在启动日志中高亮警告；未初始化时拒绝非回环启动。
- 面板不建议以 root/Administrator 运行；文档要求使用专用低权限账号，并只授予实例目录权限。
- 所有修改请求校验 CSRF 与 Origin；登录、命令、上传有独立限流。
- 路径沙箱覆盖读、写、删除、改名、解压、备份源；拒绝符号链接。
- 启动命令由管理员填写，面板不拼接其他输入；界面明确提示命令以面板权限执行。
- 文件上传先写临时文件再原子替换；解压限制条目数和总大小。
- RCON 密码只从 properties 读取，不写数据库、不进日志、不进审计详情。
- 备份包包含服务器配置和存档，视为敏感数据；下载需登录并记审计。
- 会话 Cookie httpOnly、SameSite=Lax；HTTPS 部署时设置 `COOKIE_SECURE=true`。
- 安全响应头：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、CSP 限制为同源、`img-src 'self' data:`、`style-src 'self' 'unsafe-inline'`（CodeMirror 需要内联样式）。
- 错误响应不返回堆栈和内部路径；服务端日志保留完整堆栈。
- 数据库文件、密钥文件权限：Linux 0600；Windows 依赖用户目录 ACL，文档提示不要放在共享目录。
- 不做自动更新；避免引入供应链执行面。

## 20. 部署与运维

### 20.1 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `production` | |
| `PANEL_HOST` | `127.0.0.1` | 监听地址 |
| `PANEL_PORT` | `3000` | 面板端口 |
| `DATA_DIR` | `./data` | 数据目录 |
| `SESSION_SECRET` | 自动生成 | 缺省时生成 `data/secret.key` 并复用 |
| `COOKIE_SECURE` | `false` | HTTPS 时设为 true |
| `TRUST_PROXY` | `false` | 反向代理时设为 true |
| `LOG_LEVEL` | `info` | pino 级别 |
| `MAX_UPLOAD_MB` | `1024` | 单文件上传上限 |

### 20.2 开发

```bash
npm install
npm run dev
```

- 后端：`tsx watch apps/server/src/index.ts`；
- 前端：Vite dev server，代理 `/api` 和 `/api/ws`；
- 测试数据目录：`DATA_DIR=./data-dev`。

### 20.3 构建与生产

```bash
npm run build
npm start
```

- 前端构建到 `apps/web/dist`；
- 后端编译到 `apps/server/dist`；
- Fastify 在生产模式托管 SPA，未匹配的非 `/api` 路由回退到 `index.html`；
- 启动时自动执行数据库迁移；
- 访问 `http://127.0.0.1:3000`。

### 20.4 Windows 一键启动

`scripts/start-panel.bat`：

1. 切换到脚本所在目录；
2. 检查 `node -v`，不存在或主版本低于 22 则提示安装 Node.js 22+ 并退出；
3. `node_modules` 不存在则执行 `npm ci`（无锁文件则 `npm install`）；
4. 生产构建不存在则执行 `npm run build`；
5. 启动 `npm start`；
6. 等待 2 秒后读取 `.env` 中的 `PANEL_HOST`/`PANEL_PORT`（缺省 `127.0.0.1:3000`），用默认浏览器打开；
7. 控制台窗口保持打开，Ctrl+C 只停面板，不停 Minecraft 服务器。

首次运行若 `.env` 不存在，由服务端使用默认配置并生成 `data/secret.key`，无需手工创建。

### 20.5 Linux systemd

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

要求：

- `mcpanel` 用户对实例目录有读写权限；
- 不建议 root；
- `data/` 与备份目录权限 0700；
- 反向代理（Caddy/Nginx）负责 TLS，面板只监听 127.0.0.1。

### 20.6 升级与数据备份

升级步骤：

1. 停止面板（不停止 Minecraft）；
2. 复制 `data/panel.db` 和 `data/backups/`；
3. 更新代码，执行 `npm ci`、`npm run build`；
4. 启动面板，自动跑迁移；
5. 登录检查实例状态。

面板自身数据库不做自动备份；文档明确建议定期复制 `data/panel.db`（面板停止时）或使用 SQLite 在线备份脚本。

### 20.7 健康检查

- `GET /api/health` 返回 `{ "ok": true, "version": "0.1.0" }`，无需认证，不暴露实例信息；
- 面板日志写入 `data/logs/panel.log`，按 10 MB 轮转，保留 5 个文件。

## 21. 测试策略

### 21.1 单元测试（Vitest）

必须覆盖：

- 路径沙箱：`..`、编码穿越、Windows 反斜杠、绝对路径、符号链接、数据目录重叠；
- `server.properties` 补丁：保留注释、顺序、重复键、CRLF/LF、追加新键；
- 状态机：所有合法/非法转换、启动超时、强杀、孤儿恢复；
- RCON `list` 解析：0 人、多人、格式变体、非法输出；
- cron 校验与未来运行时间；
- 备份 manifest、保留策略、安全备份保护；
- zip-slip 与 zip 炸弹限制；
- 错误码映射。

### 21.2 集成测试

使用临时目录 + 假 Java 服务端 + 假 RCON：

- `test/fixtures/fake-server.mjs`：打印启动日志、写 `logs/latest.log`、响应 stdin 的 `stop`、支持延迟退出和崩溃模式；
- 假 RCON 服务：实现最小协议，响应 `list`、`save-off`、`save-all flush`、`save-on`、`stop`；收到 `save-all flush` 时向 `logs/latest.log` 追加 `Saved the game`；
- 覆盖：
  - 首次初始化 → 登录 → 纳管 → 启动 → 控制台输出 → 停止；
  - 面板重启后孤儿检测（模拟 PID 文件/进程）；
  - 严格备份：RCON 冻结成功、超时中止、RCON 不可用拒绝；
  - 恢复：成功替换、失败回滚；
  - 计划任务触发、重叠跳过；
  - 文件保存 mtime 冲突；
  - 未认证/CSRF/越权路径。

### 21.3 前端测试

- Testing Library：状态徽章、确认框、表单校验、错误提示、控制台自动滚动状态；
- Playwright 冒烟（Chromium）：
  1. 初始化管理员；
  2. 纳管临时假服务器；
  3. 启动并看到控制台日志；
  4. 发送命令；
  5. 创建备份并看到成功；
  6. 停止服务器；
  7. 恢复备份；
  8. 刷新页面确认状态保持。
- 响应式检查：1280px 与 375px 宽度下无横向溢出、控制台可用。

### 21.4 手工验收矩阵

| 场景 | Windows | Linux |
| --- | --- | --- |
| Fabric / Forge / NeoForge 真实服务端启动与停止 | 必测 | 必测 |
| 面板重启时服务器仍在运行 | 必测 | 必测 |
| 运行中严格备份 | 必测 | 必测 |
| 备份恢复 | 必测 | 必测 |
| RCON 启用/玩家操作 | 必测 | 必测 |
| GBK 日志编码 | 选测 | 选测 |
| 中文路径/空格路径 | 必测 | 必测 |
| 长路径（Windows > 260 字符） | 选测 | 不适用 |

### 21.5 安全测试

- 路径穿越 payload 集合；
- 未登录访问所有 API；
- 缺失/错误 CSRF token；
- 未认证 WebSocket 与错误 Origin；
- 登录暴力破解限流；
- 上传超大文件和 zip 炸弹；
- 审计中不出现密码字段。

## 22. 交付阶段与验收标准

### 阶段 1：核心骨架与实例控制

交付：

- npm workspaces 工程、数据库迁移、首次初始化、登录；
- 实例纳管（probe + 创建）、列表、详情；
- 启动/停止/重启/强杀、状态机、孤儿恢复；
- 控制台实时输出、命令输入、日志下载；
- 仪表盘系统指标、实例指标；
- 路径沙箱、审计基础。

验收：

- 全新环境 5 分钟内完成初始化并纳管一个已有 Fabric 服务器；
- 能启动、看到日志、发送命令、优雅停止；
- 面板重启后正确识别运行中的服务器为 `orphaned`，可通过 RCON 停止；
- 所有 API 未登录不可访问，路径穿越被拒绝；
- 单元测试与集成测试通过。

### 阶段 2：玩家、文件与配置

交付：

- RCON 连接、状态、 一键启用；
- 在线玩家、OP、白名单、封禁、踢人、广播；
- 文件浏览、上传、下载、编辑、重命名、删除、解压；
- `mods/` 启停；
- `server.properties` 表单与原始编辑；
- EULA 接受；
- 审计页。

验收：

- 玩家操作在真实服务器上生效；
- 文件编辑冲突能正确提示；
- properties 保存后注释和顺序不变；
- 模组能通过重命名禁用/启用；
- 所有写操作可在审计页查到。

### 阶段 3：备份、计划与部署打磨

交付：

- 严格一致备份、保留策略、下载、删除；
- 恢复与回滚；
- 定时备份/启停/重启/命令/广播；
- 运行记录；
- Windows `start-panel.bat`、Linux systemd 文档；
- Playwright 冒烟、完整测试与界面打磨。

验收：

- 运行中备份严格冻结存档，RCON 不可用时拒绝；
- 恢复前自动生成安全备份，失败可回滚；
- 定时任务按配置执行，重叠跳过，离线不补跑；
- Windows 双击 bat 可启动面板并打开浏览器；
- 手工验收矩阵全部通过。

### 全局完成定义

- `npm run lint`、`npm run typecheck`、`npm test`、`npm run test:e2e` 全部通过；
- 生产构建可启动，刷新任意前端路由不 404；
- 控制台在 1280px 和 375px 下可用；
- 无已知未处理的安全问题；
- README 包含安装、启动、备份、升级、忘记密码说明。

## 23. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Windows 下进程树停止不可靠 | 服务器残留 | `taskkill /T /F`；集成测试模拟；超时和审计提示 |
| 模组服启动完成日志格式不一 | 状态长期停在 `starting` | 多模式匹配 + RCON 探测 + 300 秒存活兜底 |
| RCON 不可用导致玩家/备份能力缺失 | 功能受限 | 明确状态提示、一键启用引导、严格备份拒绝而不是降级 |
| 存档很大导致备份慢/磁盘满 | 备份失败或磁盘耗尽 | 预检查磁盘 1.5 倍、进度条、保留策略、全局并发 2 |
| 面板崩溃时 `save-off` 未恢复 | 存档长时间不写盘 | 启动恢复时检测并发送 `save-on` |
| 路径穿越/符号链接逃逸 | 任意文件读写 | 逐级 lstat + realpath + 专门测试 |
| 管理员启动命令写错 | 启动失败或执行危险命令 | 命令由管理员确认、启动失败日志提示、审计 |
| GBK 插件日志乱码 | 控制台不可读 | `log_encoding` 支持 `gbk` |
| 备份恢复覆盖错文件 | 数据丢失 | 停服要求、安全备份、先解压后交换、失败回滚 |
| 面板以高权限运行 | 风险放大 | 文档要求专用低权限账号，界面提示 |
| 依赖原生模块安装失败 | 无法启动 | 选择有预编译包的 `better-sqlite3`、`argon2`；README 提供 Windows 构建工具说明 |

## 24. 后续路线（不属于第一版）

- 远程节点 Agent：同构 NodeDriver、Token 认证、节点注册与健康检查。
- 多用户与角色权限：只读管理员、实例级授权。
- 一键安装/版本切换、整合包导入。
- 模组元数据解析、依赖检查、更新提示。
- 备份到外部存储（S3、WebDAV）与跨机复制。
- 指标长期存储与告警（Discord/Webhook/邮件）。
- 自动重启策略与定时开服。
- 文件回收站与操作撤销。
- Docker 部署与容器化节点。
- 玩家皮肤（可配置的外部服务，默认关闭）。
- 插件/模组专属面板（经济、领地等）。

本期不存在未决项；新增需求进入上述后续路线，不阻塞第一版实现。
