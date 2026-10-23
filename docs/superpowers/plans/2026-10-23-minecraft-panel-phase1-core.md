# Minecraft 面板 · 阶段 1（核心骨架与实例控制）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个可运行的 Minecraft 服务器管理面板：首次初始化、登录、纳管已有 Java 服务器、启动/停止/重启/强杀、实时控制台、命令输入、日志下载、仪表盘指标、孤儿进程恢复，且默认只监听本机并做路径沙箱。

**Architecture:** npm workspaces 单仓库（`apps/server`、`apps/web`、`packages/shared`）。Fastify 5 同时提供 REST、WebSocket 和生产 SPA；SQLite 用 better-sqlite3 + Drizzle；实例进程由 `InstanceSupervisor` 管理，底层通过 `LocalNodeDriver` 接触进程与文件；RCON 由独立 `RconService` 惰性连接。共享类型与 Zod schema 放在 `packages/shared`。

**Tech Stack:** Node.js 24、TypeScript strict、Fastify 5、@fastify/websocket、@fastify/cookie、@fastify/csrf-protection、@fastify/rate-limit、@fastify/static、better-sqlite3、drizzle-orm、Zod 3、argon2、rcon-client、pidusage、systeminformation、pino + pino-roll、React 19、Vite 7、Tailwind CSS 4、TanStack Query 5、Zustand 5、react-router-dom 7、Radix Dialog、lucide-react、@tanstack/react-virtual、Recharts、Vitest、Testing Library。

**Spec:** `docs/superpowers/specs/2026-10-23-minecraft-server-panel-design.md`（下称“规格”）

**阶段边界：** 本计划只覆盖规格第 22 节“阶段 1”。阶段 2（玩家/文件/配置）与阶段 3（备份/计划/部署）在阶段 1 验收通过后分别立计划；规格中的完整 `NodeDriver` 接口与 `archive/extract` 等方法在后续阶段扩展。RCON 按规格服务层由 `RconService` 实现，后续接远程 Agent 时在服务内部切换传输。

**现状：** 目录内只有设计文档，没有任何应用代码，也不是 git 仓库。

---

## 文件结构（阶段 1 结束时的形态）

```text
.
├─ package.json / package-lock.json / tsconfig.base.json / eslint.config.js
├─ .env.example / .gitignore / README.md
├─ scripts/dev.mjs
├─ apps/server/
│  ├─ package.json / tsconfig.json / tsup.config.ts / drizzle.config.ts
│  ├─ drizzle/0000_init.sql
│  ├─ src/
│  │  ├─ index.ts                    启动、环境、日志、非回环拦截
│  │  ├─ app.ts                      Fastify 组装、错误处理、安全头、静态托管
│  │  ├─ config.ts                   环境变量、数据目录、secret.key
│  │  ├─ logger.ts                   pino + 文件轮转
│  │  ├─ db/{schema,client,migrate}.ts
│  │  ├─ auth/{password,session,guard}.ts
│  │  ├─ routes/{auth,instances,audit,system}.ts
│  │  ├─ services/
│  │  │  ├─ audit-service.ts
│  │  │  ├─ instance-service.ts
│  │  │  ├─ probe-service.ts
│  │  │  ├─ properties-service.ts
│  │  │  ├─ state-machine.ts
│  │  │  ├─ console-buffer.ts
│  │  │  ├─ instance-supervisor.ts
│  │  │  ├─ rcon-service.ts
│  │  │  ├─ metrics-service.ts
│  │  │  └─ instance-serializer.ts
│  │  ├─ nodes/{driver,local-driver,path-sandbox,process-tree,java-detect,port-check}.ts
│  │  ├─ ws/hub.ts
│  │  └─ utils/{errors,ansi,disk}.ts
│  └─ test/{helpers,unit,integration,fixtures}/
├─ apps/web/
│  ├─ package.json / tsconfig.json / vite.config.ts / vitest.config.ts / index.html
│  └─ src/
│     ├─ main.tsx / router.tsx / styles/index.css
│     ├─ api/client.ts / ws/client.ts
│     ├─ stores/realtime.ts / stores/ui.ts
│     ├─ layouts/{AppShell,InstanceLayout}.tsx
│     ├─ pages/{SetupPage,LoginPage,DashboardPage,InstancesPage}.tsx
│     ├─ pages/instance/{OverviewTab,ConsoleTab,InstanceSettingsTab}.tsx
│     ├─ components/{ui/*,StatusBadge,ConfirmDialog,MetricsSparkline,ConsoleViewer,CommandInput,CreateInstanceDialog}.tsx
│     └─ test/{setup.ts,*.test.tsx}
└─ packages/shared/
   ├─ package.json / tsconfig.json
   ├─ src/{index,constants,errors,types}.ts + src/schemas/{auth,instance,common,ws}.ts
   └─ test/schemas.test.ts
```

职责约定：

- `packages/shared` 只放无 Node 依赖的常量、类型、Zod schema；前后端都从这里导入。
- `nodes/` 只接触操作系统；`services/` 承载业务规则；`routes/` 只做校验、调用服务、序列化。
- 每个实例的运行时数据只存在 `InstanceSupervisor` 内存中；数据库保存可恢复的 `last_state`/`last_pid`。
- 前端只有一个 WS 单例与一个 Zustand 实时 store；REST 缓存全部走 TanStack Query。

---

## Task 1: 初始化仓库与 npm workspaces

**Files:**
- Create: `.gitignore`, `package.json`, `tsconfig.base.json`, `eslint.config.js`, `.env.example`, `scripts/dev.mjs`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/tsup.config.ts`
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/vitest.config.ts`, `apps/web/index.html`

- [ ] **Step 1: 初始化 git 仓库**

Run: `git rev-parse --is-inside-work-tree || git init`
Expected: 先输出 `fatal: not a git repository...`（或空），随后 `Initialized empty Git repository in ...`。

- [ ] **Step 2: 写根配置**

`.gitignore`：

```gitignore
node_modules/
dist/
data/
data-dev/
.env
*.log
coverage/
test-results/
playwright-report/
```

`package.json`：

```json
{
  "name": "mcpanel",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "node scripts/dev.mjs",
    "build": "npm run build -w @mcpanel/web && npm run build -w @mcpanel/server",
    "start": "node apps/server/dist/index.js",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "lint": "eslint .",
    "test": "npm run test --workspaces --if-present"
  }
}
```

`tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  }
}
```

`eslint.config.js`：

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'data/**', 'data-dev/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
```

`.env.example`：

```dotenv
NODE_ENV=production
PANEL_HOST=127.0.0.1
PANEL_PORT=3000
DATA_DIR=./data
COOKIE_SECURE=false
TRUST_PROXY=false
LOG_LEVEL=info
MAX_UPLOAD_MB=1024
```

`scripts/dev.mjs`：

```js
import { spawn } from 'node:child_process';

const children = [
  spawn('npm', ['run', 'dev', '-w', '@mcpanel/server'], { stdio: 'inherit', shell: process.platform === 'win32' }),
  spawn('npm', ['run', 'dev', '-w', '@mcpanel/web'], { stdio: 'inherit', shell: process.platform === 'win32' }),
];

const stop = () => {
  for (const child of children) child.kill();
  process.exit(0);
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
```

- [ ] **Step 3: 写三个 workspace 的清单与工具配置**

`packages/shared/package.json`：

```json
{
  "name": "@mcpanel/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": { "zod": "^3.25.0" }
}
```

`packages/shared/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023"], "types": [] },
  "include": ["src", "test"]
}
```

`apps/server/package.json`：

```json
{
  "name": "@mcpanel/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@fastify/cookie": "^11.0.0",
    "@fastify/csrf-protection": "^8.0.0",
    "@fastify/rate-limit": "^10.0.0",
    "@fastify/static": "^8.0.0",
    "@fastify/websocket": "^11.0.0",
    "@mcpanel/shared": "0.1.0",
    "argon2": "^0.44.0",
    "better-sqlite3": "^12.0.0",
    "drizzle-orm": "^0.44.0",
    "fastify": "^5.0.0",
    "iconv-lite": "^0.6.3",
    "pidusage": "^3.0.2",
    "pino": "^9.0.0",
    "pino-roll": "^3.0.0",
    "rcon-client": "^4.2.5",
    "systeminformation": "^5.23.0",
    "ws": "^8.0.0",
    "zod": "^3.25.0"
  }
}
```

`apps/server/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "test", "tsup.config.ts", "drizzle.config.ts"]
}
```

`apps/server/tsup.config.ts`：

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  noExternal: ['@mcpanel/shared'],
});
```

`apps/web/package.json`：

```json
{
  "name": "@mcpanel/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@mcpanel/shared": "0.1.0",
    "@radix-ui/react-dialog": "^1.1.0",
    "@radix-ui/react-dropdown-menu": "^2.1.0",
    "@tanstack/react-query": "^5.60.0",
    "@tanstack/react-virtual": "^3.10.0",
    "lucide-react": "^0.468.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.0.0",
    "recharts": "^3.0.0",
    "zustand": "^5.0.0"
  }
}
```

`apps/web/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["vite/client"]
  },
  "include": ["src", "test", "vite.config.ts", "vitest.config.ts"]
}
```

`apps/web/vite.config.ts`：

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
```

`apps/web/vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    css: false,
  },
});
```

`apps/web/index.html`：

```html
<!doctype html>
<html lang="zh-CN" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="dark light" />
    <title>MC Panel</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: 安装依赖**

Run:

```bash
npm install -D typescript tsx tsup vitest eslint @eslint/js typescript-eslint @types/node
npm install -w @mcpanel/server
npm install -w @mcpanel/web
npm install -w @mcpanel/web -D vite @vitejs/plugin-react tailwindcss @tailwindcss/vite vitest jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom @types/react @types/react-dom
npm install -w @mcpanel/server -D @types/better-sqlite3 @types/ws drizzle-kit pino-pretty
```

Expected: 四个命令都以 `added ... packages` 结束，且根目录生成 `package-lock.json`。若 `better-sqlite3` 或 `argon2` 安装失败，按 README 提示安装 Windows Build Tools 后重试，不要跳过。

- [ ] **Step 5: 验证并提交**

Run: `npx eslint --version && git status --short`
Expected: 输出 ESLint 版本；`git status` 列出上述新文件与 `docs/`，无 `node_modules`。

```bash
git add .gitignore package.json package-lock.json tsconfig.base.json eslint.config.js .env.example scripts packages apps docs
git commit -m "chore: scaffold npm workspaces for mcpanel"
```

---

## Task 2: 共享契约（常量、错误、类型、Zod schema）

**Files:**
- Create: `packages/shared/src/constants.ts`, `errors.ts`, `types.ts`, `schemas/auth.ts`, `schemas/instance.ts`, `schemas/common.ts`, `schemas/ws.ts`, `index.ts`
- Test: `packages/shared/test/schemas.test.ts`

- [ ] **Step 1: 写失败测试**

`packages/shared/test/schemas.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  ERROR_HTTP_STATUS,
  channelPattern,
  consoleCommandSchema,
  createInstanceSchema,
  markStoppedSchema,
  setupSchema,
} from '../src/index';

describe('shared contracts', () => {
  it('rejects a password shorter than 12 characters', () => {
    const result = setupSchema.safeParse({ username: 'admin', password: 'short' });
    expect(result.success).toBe(false);
  });

  it('applies instance defaults', () => {
    const parsed = createInstanceSchema.parse({
      name: '生存服',
      rootPath: 'D:\\servers\\survival',
      startCommand: 'run.bat',
    });
    expect(parsed.stopTimeoutSec).toBe(30);
    expect(parsed.logEncoding).toBe('utf-8');
    expect(parsed.backupKeep).toBe(10);
    expect(parsed.backupIncludeConfig).toBe(true);
    expect(parsed.backupExtraPaths).toEqual([]);
  });

  it('rejects multiline console commands', () => {
    expect(consoleCommandSchema.safeParse({ command: 'say a\nsay b' }).success).toBe(false);
  });

  it('only accepts known channels', () => {
    expect(channelPattern.test('instance:0b9e3a2e-8a41-4f7e-9a8e-1f2d3c4b5a69:console')).toBe(true);
    expect(channelPattern.test('instance:x:console')).toBe(false);
    expect(channelPattern.test('system:metrics')).toBe(true);
  });

  it('requires explicit confirmation for mark-stopped', () => {
    expect(markStoppedSchema.safeParse({}).success).toBe(false);
    expect(markStoppedSchema.safeParse({ confirm: true }).success).toBe(true);
  });

  it('maps every error code to an HTTP status', () => {
    for (const code of API_ERROR_CODES) {
      expect(ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/shared`
Expected: FAIL，报错 `Failed to resolve import "../src/index"` 或找不到导出。

- [ ] **Step 3: 实现共享模块**

`packages/shared/src/constants.ts`：

```ts
export const PANEL_VERSION = '0.1.0';
export const SESSION_COOKIE = 'mcpanel_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CONSOLE_BUFFER_SIZE = 5000;
export const CONSOLE_HISTORY_BYTES = 64 * 1024;
export const WS_CHANNEL_PATTERN =
  /^(instance:[0-9a-f-]{36}:(console|status|metrics|players)|system:metrics|task:[0-9a-f-]{36})$/;

export const INSTANCE_STATES = ['stopped', 'starting', 'running', 'stopping', 'crashed', 'orphaned', 'unknown'] as const;
export type InstanceState = (typeof INSTANCE_STATES)[number];

export const RCON_STATUSES = ['disabled', 'auth_failed', 'unreachable', 'connected', 'disconnected'] as const;
export type RconStatus = (typeof RCON_STATUSES)[number];

export const LOG_ENCODINGS = ['utf-8', 'gbk'] as const;
export type LogEncoding = (typeof LOG_ENCODINGS)[number];
```

`packages/shared/src/errors.ts`：

```ts
export const API_ERROR_CODES = [
  'AUTH_REQUIRED',
  'INVALID_CREDENTIALS',
  'LOGIN_RATE_LIMITED',
  'SETUP_COMPLETED',
  'FORBIDDEN',
  'CSRF_INVALID',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'INVALID_STATE',
  'OPERATION_IN_PROGRESS',
  'INVALID_ROOT',
  'ROOT_OVERLAPS',
  'PATH_OUTSIDE_ROOT',
  'SYMLINK_NOT_ALLOWED',
  'FILE_TOO_LARGE',
  'MTIME_CONFLICT',
  'UNSUPPORTED_FILE',
  'ZIP_INVALID',
  'JAVA_NOT_FOUND',
  'EULA_NOT_ACCEPTED',
  'PORT_IN_USE',
  'RCON_DISABLED',
  'RCON_UNAVAILABLE',
  'BACKUP_BUSY',
  'BACKUP_REQUIRES_STOP_OR_RCON',
  'RESTORE_REQUIRES_STOP',
  'INSUFFICIENT_DISK',
  'INVALID_CRON',
  'COMMAND_RATE_LIMITED',
  'KILL_FAILED',
  'INTERNAL',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const ERROR_HTTP_STATUS: Record<ApiErrorCode, number> = {
  AUTH_REQUIRED: 401,
  INVALID_CREDENTIALS: 401,
  LOGIN_RATE_LIMITED: 429,
  SETUP_COMPLETED: 403,
  FORBIDDEN: 403,
  CSRF_INVALID: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  INVALID_STATE: 409,
  OPERATION_IN_PROGRESS: 409,
  INVALID_ROOT: 400,
  ROOT_OVERLAPS: 409,
  PATH_OUTSIDE_ROOT: 403,
  SYMLINK_NOT_ALLOWED: 403,
  FILE_TOO_LARGE: 413,
  MTIME_CONFLICT: 409,
  UNSUPPORTED_FILE: 415,
  ZIP_INVALID: 400,
  JAVA_NOT_FOUND: 409,
  EULA_NOT_ACCEPTED: 409,
  PORT_IN_USE: 409,
  RCON_DISABLED: 409,
  RCON_UNAVAILABLE: 409,
  BACKUP_BUSY: 409,
  BACKUP_REQUIRES_STOP_OR_RCON: 409,
  RESTORE_REQUIRES_STOP: 409,
  INSUFFICIENT_DISK: 507,
  INVALID_CRON: 400,
  COMMAND_RATE_LIMITED: 429,
  KILL_FAILED: 500,
  INTERNAL: 500,
};

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
}
```

`packages/shared/src/types.ts`：

```ts
import type { InstanceState, LogEncoding, RconStatus } from './constants';

export interface UserInfo {
  id: string;
  username: string;
  role: 'admin';
}

export interface AuthStatus {
  setupRequired: boolean;
  authenticated: boolean;
  user: UserInfo | null;
}

export interface InstanceStatusSnapshot {
  instanceId: string;
  state: InstanceState;
  pid: number | null;
  startedAt: string | null;
  exitCode: number | null;
  error: string | null;
}

export interface InstanceInfo {
  id: string;
  name: string;
  rootPath: string;
  startCommand: string;
  javaPath: string | null;
  stopTimeoutSec: number;
  logEncoding: LogEncoding;
  rconHost: string | null;
  backupKeep: number;
  backupIncludeMods: boolean;
  backupIncludeConfig: boolean;
  backupExtraPaths: string[];
  state: InstanceState;
  pid: number | null;
  startedAt: string | null;
  exitCode: number | null;
  lastError: string | null;
  rconStatus: RconStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProbeResult {
  rootPath: string;
  valid: boolean;
  detected: {
    startScripts: string[];
    serverJars: string[];
    levelName: string;
    serverPort: number;
    enableRcon: boolean;
    rconPort: number;
    onlineMode: boolean;
    hasMods: boolean;
    hasConfig: boolean;
    eula: boolean;
  };
  java: { path: string; major: number } | null;
  suggestedStartCommand: string | null;
  warnings: { code: string; message: string }[];
}

export interface ConsoleLine {
  seq: number;
  ts: string;
  stream: 'stdout' | 'stderr' | 'rcon';
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface SystemMetricsSample {
  ts: string;
  cpuPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  diskFreeBytes: number;
  diskTotalBytes: number;
  uptimeSec: number;
  platform: string;
  arch: string;
  nodeVersion: string;
  panelVersion: string;
}

export interface ProcessMetricsSample {
  ts: string;
  cpu: number;
  memBytes: number;
  diskFreeBytes: number;
}

export interface AuditEntry {
  id: string;
  userId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RootValidation {
  realPath: string;
  rootKey: string;
}

export interface StartSpec {
  instanceId: string;
  rootPath: string;
  startCommand: string;
  logEncoding: LogEncoding;
}

export interface ProcessSnapshot {
  instanceId: string;
  pid: number;
  startedAt: number;
}

export interface RconTarget {
  host: string;
  port: number;
  password: string;
}

export interface RconProbe {
  status: RconStatus;
  error: string | null;
}

export interface PlayerListResult {
  online: string[];
  max: number;
  warning: string | null;
}

export type ServerWsMessage =
  | { type: 'hello'; channels: string[]; serverTime: string }
  | { type: 'console.snapshot'; channel: string; lines: ConsoleLine[]; lastSeq: number; gap: boolean }
  | { type: 'console.append'; channel: string; lines: ConsoleLine[] }
  | { type: 'console.gap'; channel: string; dropped: number }
  | { type: 'instance.state'; instanceId: string; state: InstanceState; pid: number | null; startedAt: string | null; error: string | null }
  | { type: 'metrics.sample'; target: 'system'; ts: string; sample: SystemMetricsSample }
  | { type: 'metrics.sample'; target: 'instance'; instanceId: string; ts: string; sample: ProcessMetricsSample }
  | { type: 'players.update'; instanceId: string; online: string[]; max: number; rconStatus: RconStatus }
  | { type: 'notification'; level: 'info' | 'warning' | 'error'; message: string }
  | { type: 'error'; code: string; message: string };
```

`packages/shared/src/schemas/auth.ts`：

```ts
import { z } from 'zod';

export const usernameSchema = z.string().trim().min(3).max(32);
export const passwordSchema = z.string().min(12).max(128);

export const setupSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
});

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(32),
  password: z.string().min(1).max(128),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});
```

`packages/shared/src/schemas/instance.ts`：

```ts
import { z } from 'zod';
import { LOG_ENCODINGS } from '../constants';

const javaPathSchema = z.string().trim().min(1).max(4096).nullable();
const rconHostSchema = z.string().trim().min(1).max(255).nullable();

export const createInstanceSchema = z.object({
  name: z.string().trim().min(1).max(60),
  rootPath: z.string().min(1).max(4096),
  startCommand: z.string().trim().min(1).max(2000),
  javaPath: javaPathSchema.default(null),
  stopTimeoutSec: z.number().int().min(10).max(300).default(30),
  logEncoding: z.enum(LOG_ENCODINGS).default('utf-8'),
  rconHost: rconHostSchema.default(null),
  backupKeep: z.number().int().min(1).max(100).default(10),
  backupIncludeMods: z.boolean().default(false),
  backupIncludeConfig: z.boolean().default(true),
  backupExtraPaths: z.array(z.string().min(1).max(512)).max(20).default([]),
});

export const updateInstanceSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    startCommand: z.string().trim().min(1).max(2000),
    javaPath: javaPathSchema,
    stopTimeoutSec: z.number().int().min(10).max(300),
    logEncoding: z.enum(LOG_ENCODINGS),
    rconHost: rconHostSchema,
    backupKeep: z.number().int().min(1).max(100),
    backupIncludeMods: z.boolean(),
    backupIncludeConfig: z.boolean(),
    backupExtraPaths: z.array(z.string().min(1).max(512)).max(20),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个要修改的字段' });

export const probeSchema = z.object({ rootPath: z.string().min(1).max(4096) });
export const deleteInstanceSchema = z.object({ confirmName: z.string().min(1).max(60) });
export const markStoppedSchema = z.object({ confirm: z.literal(true) });
export const consoleCommandSchema = z.object({
  command: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .refine((value) => !/[\r\n]/.test(value), { message: '命令不能包含换行' }),
});
```

`packages/shared/src/schemas/common.ts`：

```ts
import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const logsQuerySchema = z.object({
  lines: z.coerce.number().int().min(1).max(2000).default(200),
});

export const auditQuerySchema = paginationSchema.extend({
  action: z.string().trim().max(80).optional(),
});
```

`packages/shared/src/schemas/ws.ts`：

```ts
import { z } from 'zod';

export const wsClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subscribe'),
    channel: z.string().min(1).max(120),
    sinceSeq: z.number().int().min(0).optional(),
  }),
  z.object({ type: z.literal('unsubscribe'), channel: z.string().min(1).max(120) }),
  z.object({ type: z.literal('ping') }),
]);
```

`packages/shared/src/index.ts`：

```ts
export * from './constants';
export * from './errors';
export * from './types';
export * from './schemas/auth';
export * from './schemas/instance';
export * from './schemas/common';
export * from './schemas/ws';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @mcpanel/shared && npm run typecheck -w @mcpanel/shared`
Expected: 6 个测试 PASS；`tsc --noEmit` 无输出。

- [ ] **Step 5: 提交**

```bash
git add packages/shared
git commit -m "feat(shared): add constants, error codes, types and zod contracts"
```

---

## Task 3: 配置、secret.key、日志与错误类型

**Files:**
- Create: `apps/server/src/config.ts`, `apps/server/src/logger.ts`, `apps/server/src/utils/errors.ts`
- Test: `apps/server/test/unit/config.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/server/test/unit/config.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSafeBind, isLoopback, loadConfig } from '../../src/config';

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpanel-config-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('config', () => {
  it('creates data directories and reuses the generated secret', () => {
    const dataDir = tempDir();
    const first = loadConfig({ NODE_ENV: 'test', DATA_DIR: dataDir });
    expect(fs.existsSync(path.join(dataDir, 'backups'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'secret.key'))).toBe(true);
    const second = loadConfig({ NODE_ENV: 'test', DATA_DIR: dataDir });
    expect(second.sessionSecret).toBe(first.sessionSecret);
    expect(first.dbPath).toBe(path.join(dataDir, 'panel.db'));
  });

  it('detects loopback hosts', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('localhost')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('192.168.1.10')).toBe(false);
  });

  it('refuses non-loopback binding before setup', () => {
    expect(() => assertSafeBind('0.0.0.0', true)).toThrow(/回环/);
    expect(() => assertSafeBind('0.0.0.0', false)).not.toThrow();
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ DATA_DIR: tempDir(), PANEL_PORT: '99999' })).toThrow(/PANEL_PORT/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/server -- test/unit/config.test.ts`
Expected: FAIL，`Cannot find module '../../src/config'`。

- [ ] **Step 3: 实现**

`apps/server/src/config.ts`：

```ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  migrationsDir: string;
  webDistDir: string;
  cookieSecure: boolean;
  trustProxy: boolean;
  logLevel: string;
  maxUploadMb: number;
  sessionSecret: string;
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export function loadOrCreateSecret(dataDir: string): string {
  const file = path.join(dataDir, 'secret.key');
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length > 0) return existing;
  }
  const secret = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv =
    env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development';
  const dataDir = path.resolve(env.DATA_DIR ?? './data');
  for (const dir of [dataDir, path.join(dataDir, 'backups'), path.join(dataDir, 'tmp'), path.join(dataDir, 'logs')]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const port = Number(env.PANEL_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PANEL_PORT 无效：${env.PANEL_PORT}`);
  }

  return {
    nodeEnv,
    host: env.PANEL_HOST ?? '127.0.0.1',
    port,
    dataDir,
    dbPath: path.join(dataDir, 'panel.db'),
    migrationsDir: path.resolve('apps/server/drizzle'),
    webDistDir: path.resolve('apps/web/dist'),
    cookieSecure: env.COOKIE_SECURE === 'true',
    trustProxy: env.TRUST_PROXY === 'true',
    logLevel: env.LOG_LEVEL ?? 'info',
    maxUploadMb: Number(env.MAX_UPLOAD_MB ?? 1024),
    sessionSecret: loadOrCreateSecret(dataDir),
  };
}

export function assertSafeBind(host: string, setupRequired: boolean): void {
  if (!isLoopback(host) && setupRequired) {
    throw new Error(`首次初始化完成前只能绑定回环地址，当前 PANEL_HOST=${host}`);
  }
}
```

`apps/server/src/utils/errors.ts`：

```ts
import { ERROR_HTTP_STATUS, type ApiErrorCode } from '@mcpanel/shared';

export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = ERROR_HTTP_STATUS[code];
  }
}
```

`apps/server/src/logger.ts`：

```ts
import path from 'node:path';
import pino, { type Logger } from 'pino';

export function createLogger(dataDir: string, level: string, pretty: boolean): Logger {
  if (pretty) {
    return pino({
      level,
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } },
    });
  }
  return pino(
    { level },
    pino.transport({
      target: 'pino-roll',
      options: {
        file: path.join(dataDir, 'logs', 'panel'),
        size: '10m',
        limit: { count: 5 },
        mkdir: true,
        dateFormat: 'yyyy-MM-dd',
      },
    }),
  );
}

export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @mcpanel/server -- test/unit/config.test.ts && npm run typecheck -w @mcpanel/server`
Expected: 4 个测试 PASS；typecheck 无输出。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/config.ts apps/server/src/logger.ts apps/server/src/utils/errors.ts apps/server/test/unit/config.test.ts
git commit -m "feat(server): add config, secret management, logging and AppError"
```

---

## Task 4: 数据库 schema、迁移、连接与测试工具

**Files:**
- Create: `apps/server/src/db/schema.ts`, `apps/server/src/db/client.ts`, `apps/server/src/db/migrate.ts`, `apps/server/drizzle/0000_init.sql`, `apps/server/drizzle.config.ts`
- Create: `apps/server/test/helpers/db.ts`, `apps/server/test/helpers/factory.ts`
- Test: `apps/server/test/integration/db.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/server/test/helpers/db.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, type DbHandle } from '../../src/db/client';
import { runMigrations, seedLocalNode } from '../../src/db/migrate';

const migrationsDir = fileURLToPath(new URL('../../drizzle', import.meta.url));

export interface TestDb extends DbHandle {
  dir: string;
  close: () => void;
}

export function createTestDb(): TestDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpanel-db-'));
  const handle = openDatabase(path.join(dir, 'panel.db'));
  runMigrations(handle.sqlite, migrationsDir);
  seedLocalNode(handle.db);
  return {
    ...handle,
    dir,
    close() {
      handle.sqlite.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
```

`apps/server/test/helpers/factory.ts`：

```ts
import { randomUUID } from 'node:crypto';
import { instances } from '../../src/db/schema';
import type { DB } from '../../src/db/client';

export function insertInstance(db: DB, overrides: Partial<typeof instances.$inferInsert> = {}): string {
  const id = overrides.id ?? randomUUID();
  const rootPath = overrides.rootPath ?? `C:\\servers\\${id}`;
  db.insert(instances)
    .values({
      id,
      nodeId: 'local',
      name: overrides.name ?? `实例-${id.slice(0, 8)}`,
      rootPath,
      rootPathKey: rootPath.toLowerCase().replaceAll('\\', '/'),
      startCommand: 'run.bat',
      stopTimeoutSec: 30,
      logEncoding: 'utf-8',
      backupKeep: 10,
      backupIncludeMods: false,
      backupIncludeConfig: true,
      backupExtraPaths: '[]',
      lastState: 'stopped',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    })
    .run();
  return id;
}
```

`apps/server/test/integration/db.test.ts`：

```ts
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { nodes, schedules } from '../../src/db/schema';
import { createTestDb, type TestDb } from '../helpers/db';
import { insertInstance } from '../helpers/factory';

let ctx: TestDb;
const opened: TestDb[] = [];

function db(): TestDb {
  ctx = createTestDb();
  opened.push(ctx);
  return ctx;
}

afterEach(() => {
  for (const item of opened.splice(0)) item.close();
});

describe('database', () => {
  it('applies migrations, enables pragmas and seeds the local node once', () => {
    const { db: orm, sqlite } = db();
    expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(orm.select().from(nodes).all()).toEqual([
      expect.objectContaining({ id: 'local', name: '本机', kind: 'local' }),
    ]);

    const again = createTestDb();
    opened.push(again);
    expect(again.db.select().from(nodes).all()).toHaveLength(1);
  });

  it('enforces case-insensitive instance names and unique root keys', () => {
    const { db: orm } = db();
    insertInstance(orm, { name: 'Survival', rootPath: 'C:\\servers\\a', rootPathKey: 'c:/servers/a' });
    expect(() => insertInstance(orm, { name: 'survival', rootPath: 'C:\\servers\\b', rootPathKey: 'c:/servers/b' })).toThrow();
    expect(() => insertInstance(orm, { name: 'Other', rootPath: 'C:\\servers\\a', rootPathKey: 'c:/servers/a' })).toThrow();
  });

  it('cascades schedules when an instance is deleted', () => {
    const { db: orm } = db();
    const instanceId = insertInstance(orm, { name: 'Cascade' });
    orm
      .insert(schedules)
      .values({
        id: 'schedule-1',
        instanceId,
        name: 'daily backup',
        cron: '0 4 * * *',
        timezone: 'Asia/Shanghai',
        actionType: 'backup',
        payloadJson: '{}',
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    orm.run(sql`DELETE FROM instances WHERE id = ${instanceId}`);
    expect(orm.select().from(schedules).all()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/server -- test/integration/db.test.ts`
Expected: FAIL，`Cannot find module '../../src/db/client'`。

- [ ] **Step 3: 写 schema 与迁移**

`apps/server/src/db/schema.ts`：

```ts
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin'] }).notNull().default('admin'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (table) => [uniqueIndex('sessions_token_hash_unique').on(table.tokenHash), index('sessions_expires_at_idx').on(table.expiresAt)],
);

export const nodes = sqliteTable('nodes', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['local', 'agent'] }).notNull(),
  baseUrl: text('base_url'),
  tokenEnc: text('token_enc'),
  createdAt: integer('created_at').notNull(),
});

export const instances = sqliteTable(
  'instances',
  {
    id: text('id').primaryKey(),
    nodeId: text('node_id')
      .notNull()
      .references(() => nodes.id),
    name: text('name').notNull(),
    rootPath: text('root_path').notNull(),
    rootPathKey: text('root_path_key').notNull(),
    startCommand: text('start_command').notNull(),
    javaPath: text('java_path'),
    stopTimeoutSec: integer('stop_timeout_sec').notNull().default(30),
    logEncoding: text('log_encoding', { enum: ['utf-8', 'gbk'] }).notNull().default('utf-8'),
    rconHost: text('rcon_host'),
    backupKeep: integer('backup_keep').notNull().default(10),
    backupIncludeMods: integer('backup_include_mods', { mode: 'boolean' }).notNull().default(false),
    backupIncludeConfig: integer('backup_include_config', { mode: 'boolean' }).notNull().default(true),
    backupExtraPaths: text('backup_extra_paths').notNull().default('[]'),
    lastState: text('last_state', {
      enum: ['stopped', 'starting', 'running', 'stopping', 'crashed', 'orphaned', 'unknown'],
    })
      .notNull()
      .default('stopped'),
    lastPid: integer('last_pid'),
    lastStartedAt: integer('last_started_at'),
    lastExitCode: integer('last_exit_code'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('instances_name_unique').on(table.name),
    uniqueIndex('instances_root_unique').on(table.nodeId, table.rootPathKey),
  ],
);

export const schedules = sqliteTable(
  'schedules',
  {
    id: text('id').primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    cron: text('cron').notNull(),
    timezone: text('timezone').notNull(),
    actionType: text('action_type', { enum: ['backup', 'start', 'stop', 'restart', 'command', 'broadcast'] }).notNull(),
    payloadJson: text('payload_json').notNull().default('{}'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastRunAt: integer('last_run_at'),
    nextRunAt: integer('next_run_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('schedules_instance_idx').on(table.instanceId)],
);

export const scheduleRuns = sqliteTable(
  'schedule_runs',
  {
    id: text('id').primaryKey(),
    scheduleId: text('schedule_id')
      .notNull()
      .references(() => schedules.id, { onDelete: 'cascade' }),
    trigger: text('trigger', { enum: ['scheduled', 'manual'] }).notNull(),
    status: text('status', { enum: ['running', 'success', 'failed', 'skipped'] }).notNull(),
    message: text('message'),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (table) => [index('schedule_runs_schedule_idx').on(table.scheduleId, table.startedAt)],
);

export const backups = sqliteTable(
  'backups',
  {
    id: text('id').primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    kind: text('kind', { enum: ['manual', 'scheduled', 'pre_restore'] }).notNull(),
    status: text('status', { enum: ['creating', 'ready', 'failed', 'restoring'] }).notNull(),
    sizeBytes: integer('size_bytes'),
    includesMods: integer('includes_mods', { mode: 'boolean' }).notNull().default(false),
    manifestJson: text('manifest_json'),
    error: text('error'),
    createdAt: integer('created_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (table) => [uniqueIndex('backups_instance_filename_unique').on(table.instanceId, table.filename)],
);

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    detailJson: text('detail_json').notNull().default('{}'),
    ip: text('ip'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('audit_created_at_idx').on(table.createdAt),
    index('audit_action_idx').on(table.action),
    index('audit_target_idx').on(table.targetType, table.targetId),
  ],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export type UserRow = typeof users.$inferSelect;
export type InstanceRow = typeof instances.$inferSelect;
export type AuditRow = typeof auditLogs.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
```

`apps/server/drizzle/0000_init.sql`：

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX users_username_unique ON users(username);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('local', 'agent')),
  base_url TEXT,
  token_enc TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE instances (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  name TEXT NOT NULL COLLATE NOCASE,
  root_path TEXT NOT NULL,
  root_path_key TEXT NOT NULL,
  start_command TEXT NOT NULL,
  java_path TEXT,
  stop_timeout_sec INTEGER NOT NULL DEFAULT 30 CHECK (stop_timeout_sec BETWEEN 10 AND 300),
  log_encoding TEXT NOT NULL DEFAULT 'utf-8' CHECK (log_encoding IN ('utf-8', 'gbk')),
  rcon_host TEXT,
  backup_keep INTEGER NOT NULL DEFAULT 10 CHECK (backup_keep BETWEEN 1 AND 100),
  backup_include_mods INTEGER NOT NULL DEFAULT 0 CHECK (backup_include_mods IN (0, 1)),
  backup_include_config INTEGER NOT NULL DEFAULT 1 CHECK (backup_include_config IN (0, 1)),
  backup_extra_paths TEXT NOT NULL DEFAULT '[]',
  last_state TEXT NOT NULL DEFAULT 'stopped' CHECK (last_state IN ('stopped', 'starting', 'running', 'stopping', 'crashed', 'orphaned', 'unknown')),
  last_pid INTEGER,
  last_started_at INTEGER,
  last_exit_code INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX instances_name_unique ON instances(name);
CREATE UNIQUE INDEX instances_root_unique ON instances(node_id, root_path_key);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('backup', 'start', 'stop', 'restart', 'command', 'broadcast')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_run_at INTEGER,
  next_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX schedules_instance_idx ON schedules(instance_id);

CREATE TABLE schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'skipped')),
  message TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX schedule_runs_schedule_idx ON schedule_runs(schedule_id, started_at);

CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('manual', 'scheduled', 'pre_restore')),
  status TEXT NOT NULL CHECK (status IN ('creating', 'ready', 'failed', 'restoring')),
  size_bytes INTEGER,
  includes_mods INTEGER NOT NULL DEFAULT 0 CHECK (includes_mods IN (0, 1)),
  manifest_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE (instance_id, filename)
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_created_at_idx ON audit_logs(created_at);
CREATE INDEX audit_action_idx ON audit_logs(action);
CREATE INDEX audit_target_idx ON audit_logs(target_type, target_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`apps/server/drizzle.config.ts`：

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
```

`apps/server/src/db/client.ts`：

```ts
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type DB = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  sqlite: Database.Database;
  db: DB;
}

export function openDatabase(dbPath: string): DbHandle {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  return { sqlite, db: drizzle(sqlite, { schema }) };
}
```

`apps/server/src/db/migrate.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { nodes } from './schema';
import type { DB } from './client';

export function runMigrations(sqlite: Database.Database, migrationsDir: string): void {
  sqlite.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(
    sqlite.prepare('SELECT name FROM _migrations').all().map((row) => (row as { name: string }).name),
  );
  const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sqlText = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const apply = sqlite.transaction(() => {
      sqlite.exec(sqlText);
      sqlite.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(file, Date.now());
    });
    apply();
  }
}

export function seedLocalNode(db: DB): void {
  db.insert(nodes)
    .values({ id: 'local', name: '本机', kind: 'local', createdAt: Date.now() })
    .onConflictDoNothing()
    .run();
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @mcpanel/server -- test/integration/db.test.ts`
Expected: 3 个测试 PASS。若 `journal_mode` 返回 `wal` 小写，符合断言；若抛 `SQLITE_ERROR: no such table`，检查迁移目录解析。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/db apps/server/drizzle apps/server/drizzle.config.ts apps/server/test/helpers apps/server/test/integration/db.test.ts
git commit -m "feat(server): add sqlite schema, migrations and test database helpers"
```

---

## Task 5: 密码、会话与审计服务

**Files:**
- Create: `apps/server/src/auth/password.ts`, `apps/server/src/auth/session.ts`, `apps/server/src/services/audit-service.ts`
- Modify: `apps/server/test/helpers/factory.ts`
- Test: `apps/server/test/unit/password.test.ts`, `apps/server/test/unit/session.test.ts`, `apps/server/test/unit/audit.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/server/test/unit/password.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { hashPassword, validatePassword, verifyPassword } from '../../src/auth/password';

describe('password', () => {
  it('hashes and verifies with argon2id', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'wrong password')).toBe(false);
  });

  it('enforces 12-128 characters', () => {
    expect(() => validatePassword('short')).toThrow(/12/);
    expect(() => validatePassword('a'.repeat(129))).toThrow(/128/);
    expect(() => validatePassword('a'.repeat(12))).not.toThrow();
  });
});
```

`apps/server/test/unit/session.test.ts`：

```ts
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { sessions, users } from '../../src/db/schema';
import { SessionService, hashToken } from '../../src/auth/session';
import { createTestDb, type TestDb } from '../helpers/db';

let ctx: TestDb;

function setup() {
  ctx = createTestDb();
  const userId = randomUUID();
  ctx.db.insert(users).values({
    id: userId,
    username: 'admin',
    passwordHash: '$argon2id$placeholder',
    role: 'admin',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }).run();
  return { userId, service: new SessionService(ctx.db) };
}

afterEach(() => ctx?.close());

describe('SessionService', () => {
  it('creates a token, stores only its hash and resolves the user', () => {
    const { userId, service } = setup();
    const { token } = service.create(userId, '127.0.0.1', 'vitest');
    expect(service.resolve(token)?.user.id).toBe(userId);
    expect(ctx.db.select().from(sessions).get()?.tokenHash).toBe(hashToken(token));
    expect(ctx.db.select().from(sessions).get()?.tokenHash).not.toBe(token);
  });

  it('rejects expired and deleted sessions, removes others and cleans up', () => {
    const { userId, service } = setup();
    const first = service.create(userId, null, null);
    const second = service.create(userId, null, null);
    service.deleteOtherSessions(userId, first.token);
    expect(service.resolve(first.token)).not.toBeNull();
    expect(service.resolve(second.token)).toBeNull();

    service.delete(first.token);
    expect(service.resolve(first.token)).toBeNull();

    const third = service.create(userId, null, null);
    ctx.db.update(sessions).set({ expiresAt: Date.now() - 1 }).run();
    expect(service.cleanupExpired()).toBeGreaterThanOrEqual(1);
    expect(service.resolve(third.token)).toBeNull();
  });
});
```

`apps/server/test/unit/audit.test.ts`：

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { AuditService, sanitizeDetail } from '../../src/services/audit-service';
import { createTestDb, type TestDb } from '../helpers/db';

let ctx: TestDb;
afterEach(() => ctx?.close());

describe('AuditService', () => {
  it('removes sensitive keys recursively', () => {
    expect(
      sanitizeDetail({
        password: 'x',
        nested: { rconPassword: 'y', token: 'z', keep: 'ok' },
        list: [{ secret: 's', name: 'Steve' }],
      }),
    ).toEqual({ nested: { keep: 'ok' }, list: [{ name: 'Steve' }] });
  });

  it('writes and pages audit entries', () => {
    ctx = createTestDb();
    const service = new AuditService(ctx.db);
    service.record({ action: 'instance.start', targetType: 'instance', targetId: 'i1', detail: { password: 'x' }, ip: '127.0.0.1' });
    service.record({ action: 'instance.stop', targetType: 'instance', targetId: 'i1' });
    const page = service.list({ page: 1, pageSize: 1, action: 'instance.start' });
    expect(page.total).toBe(1);
    expect(page.items[0]?.detail).toEqual({});
    expect(page.items[0]?.ip).toBe('127.0.0.1');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/server -- test/unit/password.test.ts test/unit/session.test.ts test/unit/audit.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

`apps/server/src/auth/password.ts`：

```ts
import argon2 from 'argon2';
import { AppError } from '../utils/errors';

const OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function validatePassword(password: string): void {
  if (password.length < 12) throw new AppError('VALIDATION_ERROR', '密码至少 12 个字符');
  if (password.length > 128) throw new AppError('VALIDATION_ERROR', '密码最多 128 个字符');
}

export function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  return argon2.hash(password, OPTIONS);
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password).catch(() => false);
}
```

`apps/server/src/auth/session.ts`：

```ts
import crypto from 'node:crypto';
import { and, eq, gt, lt, ne } from 'drizzle-orm';
import { SESSION_TTL_MS } from '@mcpanel/shared';
import type { DB } from '../db/client';
import { sessions, users, type SessionRow, type UserRow } from '../db/schema';

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface ResolvedSession {
  session: SessionRow;
  user: UserRow;
}

export class SessionService {
  constructor(private readonly db: DB) {}

  create(userId: string, ip: string | null, userAgent: string | null): { token: string; expiresAt: number } {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAt = now + SESSION_TTL_MS;
    this.db.insert(sessions).values({
      id: crypto.randomUUID(),
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      createdAt: now,
      ip,
      userAgent,
    }).run();
    return { token, expiresAt };
  }

  resolve(token: string): ResolvedSession | null {
    return (
      this.db
        .select({ session: sessions, user: users })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, Date.now())))
        .get() ?? null
    );
  }

  delete(token: string): void {
    this.db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token))).run();
  }

  deleteOtherSessions(userId: string, keepToken: string): void {
    this.db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.tokenHash, hashToken(keepToken))))
      .run();
  }

  cleanupExpired(): number {
    return this.db.delete(sessions).where(lt(sessions.expiresAt, Date.now())).run().changes;
  }
}
```

`apps/server/src/services/audit-service.ts`：

```ts
import crypto from 'node:crypto';
import { count, desc, eq } from 'drizzle-orm';
import type { AuditEntry, Paginated } from '@mcpanel/shared';
import type { Logger } from 'pino';
import type { DB } from '../db/client';
import { auditLogs } from '../db/schema';

const SENSITIVE_KEY = /pass(word)?|token|secret/i;

export function sanitizeDetail(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => sanitizeDetail(item, depth + 1));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!SENSITIVE_KEY.test(key)) result[key] = sanitizeDetail(entry, depth + 1);
    }
    return result;
  }
  return value;
}

export interface AuditInput {
  userId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  detail?: Record<string, unknown>;
  ip?: string | null;
}

export class AuditService {
  constructor(
    private readonly db: DB,
    private readonly log?: Logger,
  ) {}

  record(input: AuditInput): void {
    try {
      const detailJson = JSON.stringify(sanitizeDetail(input.detail ?? {}));
      this.db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        userId: input.userId ?? null,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        detailJson: detailJson.length > 8000 ? JSON.stringify({ truncated: true }) : detailJson,
        ip: input.ip ?? null,
        createdAt: Date.now(),
      }).run();
    } catch (error) {
      this.log?.error({ err: error }, 'failed to write audit log');
    }
  }

  list(query: { page: number; pageSize: number; action?: string }): Paginated<AuditEntry> {
    const where = query.action ? eq(auditLogs.action, query.action) : undefined;
    const total = this.db.select({ value: count() }).from(auditLogs).where(where).get()?.value ?? 0;
    const rows = this.db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .all();
    return {
      total,
      page: query.page,
      pageSize: query.pageSize,
      items: rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        detail: parseDetail(row.detailJson),
        ip: row.ip,
        createdAt: new Date(row.createdAt).toISOString(),
      })),
    };
  }
}

function parseDetail(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
```

在 `apps/server/test/helpers/factory.ts` 中追加（并把顶部 import 合并）：

```ts
import { users } from '../../src/db/schema';

export function insertUser(db: DB, username = 'admin', passwordHash = '$argon2id$placeholder'): string {
  const id = randomUUID();
  const now = Date.now();
  db.insert(users).values({ id, username, passwordHash, role: 'admin', createdAt: now, updatedAt: now }).run();
  return id;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @mcpanel/server -- test/unit/password.test.ts test/unit/session.test.ts test/unit/audit.test.ts`
Expected: 3 个文件共 6 个测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/auth apps/server/src/services/audit-service.ts apps/server/test/helpers/factory.ts apps/server/test/unit/password.test.ts apps/server/test/unit/session.test.ts apps/server/test/unit/audit.test.ts
git commit -m "feat(server): add password hashing, sessions and audit service"
```

---

## Task 6: 路径沙箱、properties、Java/端口探测与实例探测

**Files:**
- Create: `apps/server/src/nodes/path-sandbox.ts`, `apps/server/src/services/properties-service.ts`, `apps/server/src/nodes/java-detect.ts`, `apps/server/src/nodes/port-check.ts`, `apps/server/src/services/probe-service.ts`
- Test: `apps/server/test/unit/path-sandbox.test.ts`, `apps/server/test/unit/properties.test.ts`, `apps/server/test/unit/java-detect.test.ts`, `apps/server/test/unit/port-check.test.ts`, `apps/server/test/integration/probe.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/server/test/unit/path-sandbox.test.ts`：

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PathSandbox, toRootKey } from '../../src/nodes/path-sandbox';

const dirs: string[] = [];

async function temp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-sandbox-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('PathSandbox', () => {
  it('validates a normal directory and computes a stable root key', async () => {
    const dataDir = await temp();
    const root = await temp();
    const result = await new PathSandbox(dataDir).validateRoot(root, []);
    expect(result.realPath).toBe(await fs.realpath(root));
    expect(result.rootKey).toBe(toRootKey(result.realPath));
  });

  it('rejects files, filesystem root and home directory', async () => {
    const dataDir = await temp();
    const sandbox = new PathSandbox(dataDir);
    const file = path.join(dataDir, 'a.txt');
    await fs.writeFile(file, 'x');
    await expect(sandbox.validateRoot(file, [])).rejects.toMatchObject({ code: 'INVALID_ROOT' });
    await expect(sandbox.validateRoot(path.parse(dataDir).root, [])).rejects.toMatchObject({ code: 'INVALID_ROOT' });
    await expect(sandbox.validateRoot(os.homedir(), [])).rejects.toMatchObject({ code: 'INVALID_ROOT' });
  });

  it('rejects overlap with data directory and other instances', async () => {
    const dataDir = await temp();
    const root = await temp();
    const nested = path.join(root, 'nested');
    await fs.mkdir(nested);
    const sandbox = new PathSandbox(dataDir);
    await expect(sandbox.validateRoot(dataDir, [])).rejects.toMatchObject({ code: 'ROOT_OVERLAPS' });
    await expect(sandbox.validateRoot(root, [nested])).rejects.toMatchObject({ code: 'ROOT_OVERLAPS' });
  });

  it('resolves relative paths and rejects traversal', async () => {
    const dataDir = await temp();
    const root = await temp();
    await fs.mkdir(path.join(root, 'config'));
    const sandbox = new PathSandbox(dataDir);
    await expect(sandbox.resolve(root, '/config/x.yml')).resolves.toBe(path.join(root, 'config', 'x.yml'));
    await expect(sandbox.resolve(root, '../outside.txt')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_ROOT' });
    await expect(sandbox.resolve(root, 'a/../../outside.txt')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_ROOT' });
    await expect(sandbox.resolve(root, 'C:\\Windows\\win.ini')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_ROOT' });
  });

  it('rejects symlinked or junctioned paths', async () => {
    const dataDir = await temp();
    const root = await temp();
    const outside = await temp();
    await fs.symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(new PathSandbox(dataDir).resolve(root, 'link/secret.txt')).rejects.toMatchObject({ code: 'SYMLINK_NOT_ALLOWED' });
  });
});
```

`apps/server/test/unit/properties.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { parseProperties, propertyValue } from '../../src/services/properties-service';

describe('properties', () => {
  it('preserves comments, order, duplicates and CRLF', () => {
    const parsed = parseProperties('# comment\r\nmotd=Hello\r\nserver-port=25565\r\nmotd=World\r\n\r\n');
    expect(parsed.eol).toBe('\r\n');
    expect(parsed.entries.map((entry) => entry.key)).toEqual(['motd', 'server-port', 'motd']);
    expect(parsed.duplicates).toEqual(['motd']);
    expect(propertyValue(parsed, 'motd')).toBe('World');
    expect(propertyValue(parsed, 'missing', 'fallback')).toBe('fallback');
  });

  it('ignores blank lines and comments', () => {
    expect(parseProperties('! comment\n\nlevel-name=world\n').entries).toEqual([{ key: 'level-name', value: 'world', line: 3 }]);
  });
});
```

`apps/server/test/unit/java-detect.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { detectJava, javaCandidates, parseJavaMajor } from '../../src/nodes/java-detect';

describe('java detection', () => {
  it('parses old and new version strings', () => {
    expect(parseJavaMajor('openjdk version "21.0.4" 2024-07-16')).toBe(21);
    expect(parseJavaMajor('java version "1.8.0_402"')).toBe(8);
    expect(parseJavaMajor('not a java version')).toBeNull();
  });

  it('builds unique candidates with javaPath first', () => {
    const candidates = javaCandidates('/custom/java', { JAVA_HOME: '/jdk' });
    expect(candidates[0]).toBe('/custom/java');
    expect(candidates).toContain('/jdk/bin/java');
  });

  it('falls through candidates until one works', async () => {
    const result = await detectJava(null, async (command) => {
      if (command === 'java') return 'openjdk version "21.0.4"';
      throw new Error('not found');
    });
    expect(result).toEqual({ path: 'java', major: 21 });
  });
});
```

`apps/server/test/unit/port-check.test.ts`：

```ts
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { isPortFree } from '../../src/nodes/port-check';

describe('isPortFree', () => {
  it('detects an occupied port and a free one', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    expect(await isPortFree(address.port, '127.0.0.1')).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await isPortFree(address.port, '127.0.0.1')).toBe(true);
  });
});
```

`apps/server/test/integration/probe.test.ts`：

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PathSandbox } from '../../src/nodes/path-sandbox';
import { ProbeService } from '../../src/services/probe-service';

const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-probe-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('ProbeService', () => {
  it('detects scripts, jars, properties and warnings', async () => {
    const dataDir = await temp();
    const root = await temp();
    await fs.writeFile(path.join(root, 'run.bat'), '@echo off');
    await fs.writeFile(path.join(root, 'fabric-server-launch.jar'), '');
    await fs.writeFile(
      path.join(root, 'server.properties'),
      'level-name=survival\nserver-port=25570\nenable-rcon=true\nrcon.port=25580\nrcon.password=\nonline-mode=false\n',
    );
    await fs.writeFile(path.join(root, 'eula.txt'), 'eula=false\n');
    await fs.mkdir(path.join(root, 'mods'));
    await fs.mkdir(path.join(root, 'config'));

    const service = new ProbeService(new PathSandbox(dataDir), async () => ({ path: '/java', major: 21 }));
    const result = await service.probe(root, []);
    expect(result.detected).toMatchObject({
      startScripts: ['run.bat'],
      serverJars: ['fabric-server-launch.jar'],
      levelName: 'survival',
      serverPort: 25570,
      enableRcon: true,
      rconPort: 25580,
      onlineMode: false,
      eula: false,
      hasMods: true,
      hasConfig: true,
    });
    expect(result.suggestedStartCommand).toBe('run.bat');
    expect(result.java).toEqual({ path: '/java', major: 21 });
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(['EULA_NOT_ACCEPTED', 'RCON_PASSWORD_EMPTY']),
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/server -- test/unit/path-sandbox.test.ts test/unit/properties.test.ts test/unit/java-detect.test.ts test/unit/port-check.test.ts test/integration/probe.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

`apps/server/src/nodes/path-sandbox.ts`：

```ts
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RootValidation } from '@mcpanel/shared';
import { AppError } from '../utils/errors';

export function toRootKey(realPath: string): string {
  const normalized = path.resolve(realPath).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithin(parent: string, child: string): boolean {
  const p = process.platform === 'win32' ? parent.toLowerCase() : parent;
  const c = process.platform === 'win32' ? child.toLowerCase() : child;
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

export class PathSandbox {
  constructor(private readonly dataDir: string) {}

  async validateRoot(rootPath: string, otherRoots: string[]): Promise<RootValidation> {
    let real: string;
    try {
      real = await fs.realpath(path.resolve(rootPath));
    } catch {
      throw new AppError('INVALID_ROOT', '目录不存在或无法访问');
    }
    if (!(await fs.stat(real)).isDirectory()) throw new AppError('INVALID_ROOT', '不是目录');
    if (path.parse(real).root === real) throw new AppError('INVALID_ROOT', '不能使用文件系统根目录');
    const home = await fs.realpath(os.homedir()).catch(() => os.homedir());
    if (toRootKey(real) === toRootKey(home)) throw new AppError('INVALID_ROOT', '不能使用用户主目录');
    try {
      await fs.access(real, fsSync.constants.R_OK | fsSync.constants.W_OK);
    } catch {
      throw new AppError('INVALID_ROOT', '目录不可读写');
    }

    const dataReal = await fs.realpath(this.dataDir).catch(() => path.resolve(this.dataDir));
    if (isWithin(real, dataReal) || isWithin(dataReal, real)) {
      throw new AppError('ROOT_OVERLAPS', '实例目录与面板数据目录重叠');
    }
    for (const other of otherRoots) {
      const otherReal = await fs.realpath(other).catch(() => path.resolve(other));
      if (isWithin(real, otherReal) || isWithin(otherReal, real)) {
        throw new AppError('ROOT_OVERLAPS', '实例目录与其他实例重叠');
      }
    }
    return { realPath: real, rootKey: toRootKey(real) };
  }

  async resolve(root: string, relPath: string): Promise<string> {
    const normalized = this.normalizeRelative(relPath);
    const target = path.resolve(root, ...normalized.split('/').filter(Boolean));
    if (!isWithin(root, target)) throw new AppError('PATH_OUTSIDE_ROOT', '路径越界');
    await this.assertNoSymlink(root, target);
    return target;
  }

  normalizeRelative(relPath: string): string {
    if (relPath.includes('\0')) throw new AppError('PATH_OUTSIDE_ROOT', '路径非法');
    const stripped = relPath.replaceAll('\\', '/').replace(/^\/+/, '');
    const normalized = path.posix.normalize(stripped);
    if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
      throw new AppError('PATH_OUTSIDE_ROOT', '路径越界');
    }
    return normalized === '.' ? '' : normalized;
  }

  private async assertNoSymlink(root: string, target: string): Promise<void> {
    const relative = path.relative(root, target);
    if (relative === '') return;
    let current = root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try {
        if ((await fs.lstat(current)).isSymbolicLink()) throw new AppError('SYMLINK_NOT_ALLOWED', '路径包含符号链接');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
    }
  }
}
```

`apps/server/src/services/properties-service.ts`：

```ts
import fs from 'node:fs/promises';
import path from 'node:path';

export interface PropertyEntry {
  key: string;
  value: string;
  line: number;
}

export interface ParsedProperties {
  entries: PropertyEntry[];
  duplicates: string[];
  eol: '\r\n' | '\n';
}

export function parseProperties(raw: string): ParsedProperties {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const entries: PropertyEntry[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  raw.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return;
    const separator = trimmed.indexOf('=');
    if (separator < 0) return;
    const key = trimmed.slice(0, separator).trim();
    if (!key) return;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
    entries.push({ key, value: trimmed.slice(separator + 1).trim(), line: index + 1 });
  });
  return { entries, duplicates: [...duplicates], eol };
}

export function propertyValue(parsed: ParsedProperties | null, key: string, fallback = ''): string {
  if (!parsed) return fallback;
  const matches = parsed.entries.filter((entry) => entry.key === key);
  return matches.length > 0 ? matches[matches.length - 1]!.value : fallback;
}

export async function loadServerProperties(
  root: string,
): Promise<{ raw: string; parsed: ParsedProperties; mtime: number } | null> {
  try {
    const file = path.join(root, 'server.properties');
    const [raw, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    return { raw, parsed: parseProperties(raw), mtime: stat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
```

`apps/server/src/nodes/java-detect.ts`：

```ts
import { spawn } from 'node:child_process';
import path from 'node:path';

export interface JavaInfo {
  path: string;
  major: number;
}

export type JavaExec = (command: string) => Promise<string>;

export function parseJavaMajor(output: string): number | null {
  const match = output.match(/version "(?:1\.)?(\d+)/);
  return match ? Number(match[1]) : null;
}

export function javaCandidates(javaPath: string | null, env: NodeJS.ProcessEnv = process.env): string[] {
  const executable = process.platform === 'win32' ? 'java.exe' : 'java';
  const candidates: string[] = [];
  if (javaPath) candidates.push(javaPath);
  if (env.JAVA_HOME) candidates.push(path.join(env.JAVA_HOME, 'bin', executable));
  candidates.push('java');
  return [...new Set(candidates)];
}

function defaultExec(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['-version'], { windowsHide: true });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('java -version timeout'));
    }, 5000);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(output) : reject(new Error(`java exited with ${code}`));
    });
  });
}

export async function detectJava(javaPath: string | null, exec: JavaExec = defaultExec): Promise<JavaInfo | null> {
  for (const candidate of javaCandidates(javaPath)) {
    try {
      const major = parseJavaMajor(await exec(candidate));
      if (major !== null) return { path: candidate, major };
    } catch {
      // try the next candidate
    }
  }
  return null;
}
```

`apps/server/src/nodes/port-check.ts`：

```ts
import net from 'node:net';

export function isPortFree(port: number, host = '0.0.0.0'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen({ port, host });
  });
}
```

`apps/server/src/services/probe-service.ts`：

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProbeResult } from '@mcpanel/shared';
import { detectJava, type JavaInfo } from '../nodes/java-detect';
import type { PathSandbox } from '../nodes/path-sandbox';
import { loadServerProperties, propertyValue } from './properties-service';

export type JavaDetector = (javaPath: string | null) => Promise<JavaInfo | null>;

export class ProbeService {
  constructor(
    private readonly sandbox: PathSandbox,
    private readonly detect: JavaDetector = detectJava,
  ) {}

  async probe(rootPath: string, otherRoots: string[]): Promise<ProbeResult> {
    const { realPath } = await this.sandbox.validateRoot(rootPath, otherRoots);
    const entries = await fs.readdir(realPath, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    const directories = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));

    const startScripts = files.filter((file) => /^(run|start)\.(bat|cmd|sh)$/i.test(file));
    const serverJars = files.filter((file) => /\.jar$/i.test(file) && /(server|fabric|forge|neoforge)/i.test(file));
    const parsed = (await loadServerProperties(realPath))?.parsed ?? null;
    const eula = await readEula(realPath);
    const enableRcon = propertyValue(parsed, 'enable-rcon', 'false') === 'true';
    const rconPort = Number(propertyValue(parsed, 'rcon.port', '25575')) || 25575;
    const serverPort = Number(propertyValue(parsed, 'server-port', '25565')) || 25565;
    const onlineMode = propertyValue(parsed, 'online-mode', 'true') !== 'false';
    const java = await this.detect(null);

    const warnings: ProbeResult['warnings'] = [];
    if (!eula) warnings.push({ code: 'EULA_NOT_ACCEPTED', message: 'eula.txt 尚未接受' });
    if (enableRcon && propertyValue(parsed, 'rcon.password', '') === '') {
      warnings.push({ code: 'RCON_PASSWORD_EMPTY', message: 'RCON 已启用但密码为空' });
    }
    if (startScripts.length === 0) {
      warnings.push({ code: 'NO_START_SCRIPT', message: '未找到 run/start 脚本，请手动填写启动命令' });
    }

    return {
      rootPath: realPath,
      valid: true,
      detected: {
        startScripts,
        serverJars,
        levelName: propertyValue(parsed, 'level-name', 'world'),
        serverPort,
        enableRcon,
        rconPort,
        onlineMode,
        hasMods: directories.has('mods'),
        hasConfig: directories.has('config'),
        eula,
      },
      java,
      suggestedStartCommand: startScripts[0] ?? null,
      warnings,
    };
  }
}

async function readEula(root: string): Promise<boolean> {
  try {
    return /^\s*eula\s*=\s*true\s*$/im.test(await fs.readFile(path.join(root, 'eula.txt'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @mcpanel/server -- test/unit/path-sandbox.test.ts test/unit/properties.test.ts test/unit/java-detect.test.ts test/unit/port-check.test.ts test/integration/probe.test.ts`
Expected: 5 个文件共 12 个测试 PASS。Windows junction 测试若报权限错误，确认使用 `'junction'` 类型。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/nodes/path-sandbox.ts apps/server/src/nodes/java-detect.ts apps/server/src/nodes/port-check.ts apps/server/src/services/properties-service.ts apps/server/src/services/probe-service.ts apps/server/test/unit/path-sandbox.test.ts apps/server/test/unit/properties.test.ts apps/server/test/unit/java-detect.test.ts apps/server/test/unit/port-check.test.ts apps/server/test/integration/probe.test.ts
git commit -m "feat(server): add path sandbox, properties parser and instance probe"
```

> 在 Task 6 实现时给 `normalizeRelative` 补一行 Windows 盘符绝对路径拒绝：`if (/^[A-Za-z]:/.test(stripped)) throw new AppError('PATH_OUTSIDE_ROOT', '路径越界');`，否则测试中的 `C:\Windows\win.ini` 在 POSIX 上会被当作普通相对路径。

---

## Task 7: 进程树、控制台缓冲与 LocalNodeDriver

**Files:**
- Create: `apps/server/src/utils/ansi.ts`, `apps/server/src/services/console-buffer.ts`, `apps/server/src/nodes/process-tree.ts`, `apps/server/src/nodes/driver.ts`, `apps/server/src/nodes/local-driver.ts`
- Test: `apps/server/test/unit/console-buffer.test.ts`, `apps/server/test/integration/local-driver.test.ts`
- Create: `apps/server/test/fixtures/fake-server.mjs`

- [ ] **Step 1: 写失败测试**

`apps/server/test/unit/console-buffer.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { ConsoleBuffer, classifyLevel, stripAnsi } from '../../src/services/console-buffer';

describe('ConsoleBuffer', () => {
  it('increments sequence numbers and trims to capacity', () => {
    const buffer = new ConsoleBuffer(3);
    for (const text of ['a', 'b', 'c', 'd']) buffer.append({ stream: 'stdout', level: 'info', text });
    expect(buffer.snapshot().map((line) => [line.seq, line.text])).toEqual([[2, 'b'], [3, 'c'], [4, 'd']]);
  });

  it('returns append when sinceSeq is covered and snapshot with gap otherwise', () => {
    const buffer = new ConsoleBuffer(2);
    buffer.append({ stream: 'stdout', level: 'info', text: 'a' });
    buffer.append({ stream: 'stdout', level: 'info', text: 'b' });
    expect(buffer.since(1)).toMatchObject({ mode: 'append', lines: [expect.objectContaining({ text: 'b' })] });
    expect(buffer.since(0)).toMatchObject({ mode: 'snapshot', gap: false });
    buffer.append({ stream: 'stdout', level: 'info', text: 'c' });
    expect(buffer.since(0)).toMatchObject({ mode: 'snapshot', gap: true });
  });

  it('strips ANSI and classifies levels', () => {
    expect(stripAnsi('\u001b[32m[Server thread/INFO]\u001b[0m Done')).toBe('[Server thread/INFO] Done');
    expect(classifyLevel('[Server thread/ERROR]: boom')).toBe('error');
    expect(classifyLevel('[Server thread/WARN]: careful')).toBe('warn');
    expect(classifyLevel('[Server thread/INFO]: ok')).toBe('info');
  });
});
```

`apps/server/test/fixtures/fake-server.mjs`：

```js
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const root = process.cwd();
fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
const log = (line) => {
  fs.appendFileSync(path.join(root, 'logs', 'latest.log'), `${line}\n`);
  console.log(line);
};

log('[Server thread/INFO]: Starting minecraft server version 1.21.1');
setTimeout(() => log('[Server thread/INFO]: Done (2.1s)! For help, type "help"'), 200);

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  log(`[Server thread/INFO]: received ${line}`);
  if (line === 'stop') {
    log('[Server thread/INFO]: Stopping server');
    setTimeout(() => process.exit(0), 100);
  }
});
```

`apps/server/test/integration/local-driver.test.ts`：

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalNodeDriver } from '../../src/nodes/local-driver';
import { PathSandbox } from '../../src/nodes/path-sandbox';

const fixture = fileURLToPath(new URL('../fixtures/fake-server.mjs', import.meta.url));
const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-driver-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('LocalNodeDriver', () => {
  it('spawns, streams output, verifies the pid and stops', async () => {
    const dataDir = await makeRoot();
    const root = await makeRoot();
    const driver = new LocalNodeDriver(new PathSandbox(dataDir));
    const output: string[] = [];
    driver.on('output', (event: { text: string }) => output.push(event.text));

    const command = `"${process.execPath}" "${fixture}" --root "${root}"`;
    const snapshot = await driver.startProcess({ instanceId: 'i1', rootPath: root, startCommand: command, logEncoding: 'utf-8' });
    expect(driver.getProcessSnapshot('i1')?.pid).toBe(snapshot.pid);
    await waitFor(() => output.some((line) => line.includes('Done (')));
    expect(await driver.verifyPid(snapshot.pid, root)).toBe(true);

    await driver.writeStdin('i1', 'say hello');
    await waitFor(() => output.some((line) => line.includes('received say hello')));

    expect(await driver.stopProcess('i1', 10)).toEqual({ forced: false });
    expect(driver.getProcessSnapshot('i1')).toBeNull();
  }, 20000);
});

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/server -- test/unit/console-buffer.test.ts test/integration/local-driver.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

`apps/server/src/utils/ansi.ts`：

```ts
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}
```

`apps/server/src/services/console-buffer.ts`：

```ts
import { CONSOLE_BUFFER_SIZE, type ConsoleLine } from '@mcpanel/shared';
import { stripAnsi } from '../utils/ansi';

export function classifyLevel(text: string): ConsoleLine['level'] {
  if (/\b(ERROR|SEVERE|FATAL)\b/.test(text)) return 'error';
  if (/\b(WARN|WARNING)\b/.test(text)) return 'warn';
  return 'info';
}

export { stripAnsi };

export type ConsoleSnapshot =
  | { mode: 'append'; lines: ConsoleLine[] }
  | { mode: 'snapshot'; lines: ConsoleLine[]; gap: boolean };

export class ConsoleBuffer {
  private lines: ConsoleLine[] = [];
  private seq = 0;

  constructor(private readonly capacity = CONSOLE_BUFFER_SIZE) {}

  append(input: Omit<ConsoleLine, 'seq' | 'ts'> & { ts?: string }): ConsoleLine {
    const line: ConsoleLine = {
      seq: ++this.seq,
      ts: input.ts ?? new Date().toISOString(),
      stream: input.stream,
      level: input.level,
      text: stripAnsi(input.text),
    };
    this.lines.push(line);
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
    return line;
  }

  get lastSeq(): number {
    return this.seq;
  }

  get size(): number {
    return this.lines.length;
  }

  snapshot(): ConsoleLine[] {
    return [...this.lines];
  }

  since(sinceSeq: number | undefined): ConsoleSnapshot {
    const first = this.lines[0]?.seq ?? this.seq + 1;
    if (sinceSeq !== undefined && sinceSeq > 0 && sinceSeq >= first - 1 && sinceSeq <= this.seq) {
      return { mode: 'append', lines: this.lines.filter((line) => line.seq > sinceSeq) };
    }
    return { mode: 'snapshot', lines: this.snapshot(), gap: sinceSeq !== undefined && sinceSeq > 0 && sinceSeq < first - 1 };
  }
}
```

`apps/server/src/nodes/process-tree.ts`：

```ts
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { AppError } from '../utils/errors';

export function buildShellCommand(
  rootPath: string,
  startCommand: string,
  platform = process.platform,
): { file: string; args: string[] } {
  if (platform === 'win32') {
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', `cd /d "${rootPath}" && ${startCommand}`] };
  }
  const quoted = `'${rootPath.replaceAll("'", `'\\''`)}'`;
  return { file: '/bin/sh', args: ['-c', `cd -- ${quoted} && ${startCommand}`] };
}

export function spawnServer(rootPath: string, startCommand: string): ChildProcess {
  const { file, args } = buildShellCommand(rootPath, startCommand);
  return spawn(file, args, {
    cwd: rootPath,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function processMatchesRoot(
  processes: { pid: number; command: string; params: string }[],
  pid: number,
  rootPath: string,
): boolean | null {
  const found = processes.find((entry) => entry.pid === pid);
  if (!found) return false;
  const commandLine = `${found.command} ${found.params}`.toLowerCase();
  if (!commandLine.trim()) return null;
  return commandLine.includes(rootPath.toLowerCase());
}

export async function killPidTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new AppError('KILL_FAILED', `taskkill 退出码 ${code}`))));
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    try {
      process.kill(pid, 'SIGKILL');
    } catch (fallbackError) {
      if ((fallbackError as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw new AppError('KILL_FAILED', '无法结束进程');
      }
    }
  }
}
```

`apps/server/src/nodes/driver.ts`：

```ts
import type { ProcessSnapshot, RootValidation, StartSpec } from '@mcpanel/shared';

export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  mtime: string;
  symlink: boolean;
}

export interface TextFile {
  content: string;
  mtime: number;
}

export interface NodeDriver {
  validateRoot(rootPath: string, otherRoots: string[]): Promise<RootValidation>;
  listFiles(root: string, relPath: string): Promise<FileEntry[]>;
  readText(root: string, relPath: string): Promise<TextFile>;
  startProcess(spec: StartSpec): Promise<ProcessSnapshot>;
  stopProcess(instanceId: string, timeoutSec: number): Promise<{ forced: boolean }>;
  killProcessTree(instanceId: string): Promise<void>;
  writeStdin(instanceId: string, line: string): Promise<void>;
  getProcessSnapshot(instanceId: string): ProcessSnapshot | null;
  verifyPid(pid: number, rootPath: string): Promise<boolean>;
}
```

`apps/server/src/nodes/local-driver.ts`：

```ts
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import iconv from 'iconv-lite';
import si from 'systeminformation';
import { CONSOLE_HISTORY_BYTES, type LogEncoding, type ProcessSnapshot, type RootValidation, type StartSpec } from '@mcpanel/shared';
import { AppError } from '../utils/errors';
import { stripAnsi } from '../utils/ansi';
import type { FileEntry, NodeDriver, TextFile } from './driver';
import type { PathSandbox } from './path-sandbox';
import { killPidTree, processMatchesRoot, spawnServer } from './process-tree';

interface ProcessEntry {
  child: ChildProcess;
  startedAt: number;
}

export interface DriverOutputEvent {
  instanceId: string;
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface DriverExitEvent {
  instanceId: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class LocalNodeDriver extends EventEmitter implements NodeDriver {
  private readonly processes = new Map<string, ProcessEntry>();

  constructor(private readonly sandbox: PathSandbox) {
    super();
  }

  validateRoot(rootPath: string, otherRoots: string[]): Promise<RootValidation> {
    return this.sandbox.validateRoot(rootPath, otherRoots);
  }

  async listFiles(root: string, relPath: string): Promise<FileEntry[]> {
    const dir = await this.sandbox.resolve(root, relPath);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const result: FileEntry[] = [];
    for (const entry of entries) {
      if (entry.name === '.mcpanel-tmp') continue;
      const absolute = path.join(dir, entry.name);
      const stat = await fs.lstat(absolute);
      result.push({
        name: entry.name,
        type: stat.isDirectory() ? 'directory' : 'file',
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        symlink: stat.isSymbolicLink(),
      });
    }
    return result.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
  }

  async readText(root: string, relPath: string): Promise<TextFile> {
    const file = await this.sandbox.resolve(root, relPath);
    const stat = await fs.stat(file);
    if (stat.size > 2 * 1024 * 1024) throw new AppError('FILE_TOO_LARGE', '文件超过 2 MB');
    const raw = await fs.readFile(file);
    if (raw.includes(0)) throw new AppError('UNSUPPORTED_FILE', '这是二进制文件');
    return { content: raw.toString('utf8'), mtime: stat.mtimeMs };
  }

  async startProcess(spec: StartSpec): Promise<ProcessSnapshot> {
    if (this.processes.has(spec.instanceId)) throw new AppError('OPERATION_IN_PROGRESS', '进程已在运行');
    const child = spawnServer(spec.rootPath, spec.startCommand);
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const pid = child.pid;
    if (!pid) throw new AppError('INTERNAL', '无法获得进程 PID');

    const decoder = iconv.getDecoder(spec.logEncoding);
    let pending = '';
    const emitChunk = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      pending += decoder.write(chunk);
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() ?? '';
      for (const part of parts) {
        const text = stripAnsi(part);
        if (text.trim()) this.emit('output', { instanceId: spec.instanceId, stream, text } satisfies DriverOutputEvent);
      }
    };

    child.stdout?.on('data', emitChunk('stdout'));
    child.stderr?.on('data', emitChunk('stderr'));
    const startedAt = Date.now();
    child.on('exit', (code, signal) => {
      if (pending.trim()) {
        this.emit('output', { instanceId: spec.instanceId, stream: 'stdout', text: stripAnsi(pending) } satisfies DriverOutputEvent);
      }
      this.processes.delete(spec.instanceId);
      this.emit('exit', { instanceId: spec.instanceId, code, signal } satisfies DriverExitEvent);
    });

    this.processes.set(spec.instanceId, { child, startedAt });
    return { instanceId: spec.instanceId, pid, startedAt };
  }

  async stopProcess(instanceId: string, timeoutSec: number): Promise<{ forced: boolean }> {
    const entry = this.processes.get(instanceId);
    if (!entry?.child.pid) return { forced: false };
    const exited = new Promise<void>((resolve) => entry.child.once('exit', () => resolve()));
    entry.child.stdin?.write('stop\n');
    const timeout = new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), timeoutSec * 1000);
      timer.unref();
    });
    const result = await Promise.race([exited.then(() => 'exited' as const), timeout]);
    if (result === 'timeout') {
      await killPidTree(entry.child.pid);
      await exited;
      return { forced: true };
    }
    return { forced: false };
  }

  async killProcessTree(instanceId: string): Promise<void> {
    const entry = this.processes.get(instanceId);
    if (!entry?.child.pid) throw new AppError('INVALID_STATE', '没有可结束的进程');
    const exited = new Promise<void>((resolve) => entry.child.once('exit', () => resolve()));
    await killPidTree(entry.child.pid);
    await Promise.race([exited, delay(5000)]);
  }

  async writeStdin(instanceId: string, line: string): Promise<void> {
    const entry = this.processes.get(instanceId);
    if (!entry?.child.stdin || entry.child.stdin.destroyed) throw new AppError('INVALID_STATE', '控制台不可用');
    entry.child.stdin.write(`${line}\n`);
  }

  getProcessSnapshot(instanceId: string): ProcessSnapshot | null {
    const entry = this.processes.get(instanceId);
    if (!entry?.child.pid) return null;
    return { instanceId, pid: entry.child.pid, startedAt: entry.startedAt };
  }

  async verifyPid(pid: number, rootPath: string): Promise<boolean> {
    const processes = await si.processes();
    return processMatchesRoot(processes.list, pid, rootPath) !== false;
  }

  async readLogTail(rootPath: string, encoding: LogEncoding, bytes = CONSOLE_HISTORY_BYTES): Promise<string[]> {
    try {
      const file = path.join(rootPath, 'logs', 'latest.log');
      const stat = await fs.stat(file);
      const start = Math.max(0, stat.size - bytes);
      const handle = await fs.open(file, 'r');
      try {
        const buffer = Buffer.alloc(stat.size - start);
        await handle.read(buffer, 0, buffer.length, start);
        return iconv.decode(buffer, encoding).split(/\r?\n/).filter((line) => line.trim().length > 0);
      } finally {
        await handle.close();
      }
    } catch {
      return [];
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @mcpanel/server -- test/unit/console-buffer.test.ts test/integration/local-driver.test.ts`
Expected: unit 3 个 PASS；integration 1 个 PASS。Windows 上若 `verifyPid` 连续失败，检查启动命令是否包含实例根路径（本计划在命令中加入了 `--root`）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/utils/ansi.ts apps/server/src/services/console-buffer.ts apps/server/src/nodes apps/server/test/unit/console-buffer.test.ts apps/server/test/integration/local-driver.test.ts apps/server/test/fixtures/fake-server.mjs
git commit -m "feat(server): add local node driver, console buffer and process tree handling"
```

---

## Task 8: RCON 服务与假 RCON 测试服务

**Files:**
- Create: `apps/server/src/services/rcon-service.ts`
- Test: `apps/server/test/fixtures/fake-rcon.mjs`, `apps/server/test/integration/rcon.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/server/test/fixtures/fake-rcon.mjs`：

```js
import net from 'node:net';

export function startFakeRcon({ password = 'secret', port = 0 } = {}) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const length = buffer.readInt32LE(0);
          if (buffer.length < 4 + length) break;
          const packet = buffer.subarray(4, 4 + length);
          buffer = buffer.subarray(4 + length);
          const id = packet.readInt32LE(0);
          const type = packet.readInt32LE(4);
          const body = packet.subarray(8, packet.length - 2).toString('utf8');
          if (type === 3) {
            const ok = body === password;
            send(socket, ok ? id : -1, 2, '');
            if (!ok) setTimeout(() => socket.destroy(), 50);
          } else if (type === 2) {
            send(socket, id, 0, body === 'list' ? 'There are 0 of a max of 20 players online:' : `ok:${body}`);
          }
        }
      });
    });
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function send(socket, id, type, body) {
  const payload = Buffer.from(body, 'utf8');
  const length = 4 + 4 + payload.length + 2;
  const packet = Buffer.alloc(4 + length);
  packet.writeInt32LE(length, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  payload.copy(packet, 12);
  packet.writeInt16LE(0, 12 + payload.length);
  socket.write(packet);
}
```

`apps/server/test/integration/rcon.test.ts`：

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { RconService } from '../../src/services/rcon-service';
import { createTestDb, type TestDb } from '../helpers/db';
import { insertInstanceRow } from '../helpers/factory';
import { startFakeRcon } from '../fixtures/fake-rcon.mjs';

let ctx: TestDb;
let closeRcon: (() => Promise<void>) | null = null;
let root: string;

async function setup(password = 'secret', enabled = true) {
  ctx = createTestDb();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-rcon-'));
  const fake = await startFakeRcon({ password });
  closeRcon = fake.close;
  await fs.writeFile(
    path.join(root, 'server.properties'),
    `enable-rcon=${enabled}\nrcon.port=${fake.port}\nrcon.password=${password}\nserver-ip=127.0.0.1\n`,
  );
  const instance = insertInstanceRow(ctx.db, { name: `rcon-${randomUUID()}`, rootPath: root, rconHost: '127.0.0.1' });
  return { service: new RconService(), instance };
}

afterEach(async () => {
  await closeRcon?.();
  closeRcon = null;
  ctx?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe('RconService', () => {
  it('connects, sends commands and reports connected', async () => {
    const { service, instance } = await setup();
    expect((await service.test(instance)).status).toBe('connected');
    expect(await service.send(instance, 'list')).toContain('players online');
    expect(service.getCachedStatus(instance.id)).toBe('connected');
    service.closeAll();
  });

  it('reports auth_failed and disabled', async () => {
    const wrong = await setup('right');
    expect((await wrong.service.test(wrong.instance)).status).toBe('auth_failed');
    wrong.service.closeAll();
    await closeRcon?.();
    closeRcon = null;
    ctx.close();
    await fs.rm(root, { recursive: true, force: true });

    const disabled = await setup('secret', false);
    expect((await disabled.service.test(disabled.instance)).status).toBe('disabled');
    disabled.service.closeAll();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/server -- test/integration/rcon.test.ts`
Expected: FAIL，`Cannot find module '../../src/services/rcon-service'`。

- [ ] **Step 3: 实现**

`apps/server/src/services/rcon-service.ts`：

```ts
import { Rcon } from 'rcon-client';
import type { RconProbe, RconStatus, RconTarget } from '@mcpanel/shared';
import type { InstanceRow } from '../db/schema';
import { AppError } from '../utils/errors';
import { loadServerProperties, propertyValue } from './properties-service';

interface CachedConnection {
  client: Rcon;
}

export class RconService {
  private readonly cache = new Map<string, CachedConnection>();
  private readonly statuses = new Map<string, RconStatus>();

  getCachedStatus(instanceId: string): RconStatus {
    return this.statuses.get(instanceId) ?? 'unreachable';
  }

  async resolveTarget(
    instance: InstanceRow,
  ): Promise<{ kind: 'disabled' | 'missing_password' | 'ok'; target?: RconTarget }> {
    const parsed = (await loadServerProperties(instance.rootPath))?.parsed ?? null;
    if (propertyValue(parsed, 'enable-rcon', 'false') !== 'true') return { kind: 'disabled' };
    const password = propertyValue(parsed, 'rcon.password', '');
    if (!password) return { kind: 'missing_password' };
    const serverIp = propertyValue(parsed, 'server-ip', '');
    const host = instance.rconHost ?? (serverIp && serverIp !== '0.0.0.0' ? serverIp : '127.0.0.1');
    const port = Number(propertyValue(parsed, 'rcon.port', '25575')) || 25575;
    return { kind: 'ok', target: { host, port, password } };
  }

  async test(instance: InstanceRow): Promise<RconProbe> {
    const resolved = await this.resolveTarget(instance);
    if (resolved.kind === 'disabled') {
      this.setStatus(instance.id, 'disabled');
      return { status: 'disabled', error: '未启用 RCON' };
    }
    if (resolved.kind === 'missing_password') {
      this.setStatus(instance.id, 'auth_failed');
      return { status: 'auth_failed', error: 'RCON 已启用但密码为空' };
    }
    this.disconnect(instance.id);
    try {
      const client = await Rcon.connect({ ...resolved.target!, timeout: 5000 });
      await client.send('list');
      client.on('end', () => this.setStatus(instance.id, 'disconnected'));
      this.cache.set(instance.id, { client });
      this.setStatus(instance.id, 'connected');
      return { status: 'connected', error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status: RconStatus = /auth|password|login/i.test(message) ? 'auth_failed' : 'unreachable';
      this.setStatus(instance.id, status);
      return { status, error: message };
    }
  }

  async send(instance: InstanceRow, command: string): Promise<string> {
    let cached = this.cache.get(instance.id);
    if (!cached) {
      const probe = await this.test(instance);
      if (probe.status !== 'connected') {
        throw new AppError('RCON_UNAVAILABLE', probe.error ?? 'RCON 不可用', { status: probe.status });
      }
      cached = this.cache.get(instance.id);
    }
    if (!cached) throw new AppError('RCON_UNAVAILABLE', 'RCON 未连接');
    try {
      return await cached.client.send(command);
    } catch (error) {
      this.disconnect(instance.id);
      this.setStatus(instance.id, 'disconnected');
      throw new AppError('RCON_UNAVAILABLE', error instanceof Error ? error.message : 'RCON 命令失败');
    }
  }

  invalidate(instanceId: string): void {
    this.disconnect(instanceId);
    this.statuses.delete(instanceId);
  }

  closeAll(): void {
    for (const id of [...this.cache.keys()]) this.disconnect(id);
  }

  private disconnect(instanceId: string): void {
    const cached = this.cache.get(instanceId);
    if (!cached) return;
    try {
      cached.client.end();
    } catch {
      // already closed
    }
    this.cache.delete(instanceId);
  }

  private setStatus(instanceId: string, status: RconStatus): void {
    this.statuses.set(instanceId, status);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @mcpanel/server -- test/integration/rcon.test.ts`
Expected: 2 个测试 PASS。若认证失败被识别为 `unreachable`，打印 `Rcon.connect` 的原始错误并补充认证错误匹配。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/services/rcon-service.ts apps/server/test/fixtures/fake-rcon.mjs apps/server/test/integration/rcon.test.ts
git commit -m "feat(server): add lazy rcon service with fake rcon integration tests"
```

---

## Task 9: 状态机与 InstanceSupervisor

**Files:**
- Create: `apps/server/src/services/state-machine.ts`, `apps/server/src/services/instance-supervisor.ts`
- Test: `apps/server/test/unit/state-machine.test.ts`, `apps/server/test/integration/supervisor.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/server/test/unit/state-machine.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { transition } from '../../src/services/state-machine';

describe('state machine', () => {
  it('covers legal transitions', () => {
    expect(transition('stopped', 'start_requested')).toBe('starting');
    expect(transition('crashed', 'start_requested')).toBe('starting');
    expect(transition('starting', 'startup_complete')).toBe('running');
    expect(transition('starting', 'process_exited')).toBe('crashed');
    expect(transition('running', 'stop_requested')).toBe('stopping');
    expect(transition('running', 'process_exited')).toBe('crashed');
    expect(transition('stopping', 'process_exited')).toBe('stopped');
    expect(transition('orphaned', 'stop_requested')).toBe('stopping');
    expect(transition('orphaned', 'kill_requested')).toBe('stopped');
    expect(transition('orphaned', 'unmanageable')).toBe('unknown');
    expect(transition('unknown', 'mark_stopped')).toBe('stopped');
    expect(transition('unknown', 'kill_requested')).toBe('stopped');
  });

  it('rejects illegal transitions', () => {
    expect(transition('stopped', 'process_exited')).toBeNull();
    expect(transition('running', 'start_requested')).toBeNull();
    expect(transition('stopping', 'start_requested')).toBeNull();
  });
});
```

`apps/server/test/integration/supervisor.test.ts`：

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { instances } from '../../src/db/schema';
import { silentLogger } from '../../src/logger';
import { LocalNodeDriver } from '../../src/nodes/local-driver';
import { PathSandbox } from '../../src/nodes/path-sandbox';
import { AuditService } from '../../src/services/audit-service';
import { InstanceSupervisor } from '../../src/services/instance-supervisor';
import { RconService } from '../../src/services/rcon-service';
import { createTestDb, type TestDb } from '../helpers/db';
import { insertInstanceRow } from '../helpers/factory';
import { eq } from 'drizzle-orm';

const fixture = fileURLToPath(new URL('../fixtures/fake-server.mjs', import.meta.url));
const roots: string[] = [];
const supervisors: InstanceSupervisor[] = [];
let ctx: TestDb;

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-supervisor-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'eula.txt'), 'eula=true\n');
  return root;
}

function makeSupervisor(): InstanceSupervisor {
  const supervisor = new InstanceSupervisor({
    db: ctx.db,
    driver: new LocalNodeDriver(new PathSandbox(ctx.dir)),
    rcon: new RconService(),
    audit: new AuditService(ctx.db),
    logger: silentLogger(),
    dataDir: ctx.dir,
    detectJava: async () => ({ path: 'java', major: 21 }),
    portFree: async () => true,
  });
  supervisors.push(supervisor);
  return supervisor;
}

async function setup(name: string) {
  ctx = createTestDb();
  const root = await tempRoot();
  const instance = insertInstanceRow(ctx.db, {
    name,
    rootPath: root,
    startCommand: `"${process.execPath}" "${fixture}" --root "${root}"`,
    stopTimeoutSec: 10,
  });
  const supervisor = makeSupervisor();
  await supervisor.init();
  return { instance, supervisor };
}

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.shutdown();
  ctx?.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('InstanceSupervisor', () => {
  it('starts, reaches running, accepts commands and stops', async () => {
    const { instance, supervisor } = await setup('生存服');
    const lines: string[] = [];
    supervisor.on('console', (_id: string, entries: { text: string }[]) => lines.push(...entries.map((entry) => entry.text)));

    await supervisor.start(instance.id);
    await waitFor(() => supervisor.getStatus(instance.id).state === 'running');
    await waitFor(() => lines.some((line) => line.includes('Done (')));

    await supervisor.sendCommand(instance.id, 'say hello');
    await waitFor(() => lines.some((line) => line.includes('received say hello')));

    await supervisor.stop(instance.id);
    expect(supervisor.getStatus(instance.id).state).toBe('stopped');
  }, 30000);

  it('rejects start while running and recovers a missing process as crashed', async () => {
    const { instance, supervisor } = await setup('状态检查');
    await supervisor.start(instance.id);
    await waitFor(() => supervisor.getStatus(instance.id).state === 'running');
    await expect(supervisor.start(instance.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await supervisor.stop(instance.id);

    ctx.db.update(instances).set({ lastState: 'running', lastPid: 999999 }).where(eq(instances.id, instance.id)).run();
    const restarted = makeSupervisor();
    await restarted.init();
    expect(restarted.getStatus(instance.id).state).toBe('crashed');
  }, 30000);
});

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/server -- test/unit/state-machine.test.ts test/integration/supervisor.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现状态机**

`apps/server/src/services/state-machine.ts`：

```ts
import type { InstanceState } from '@mcpanel/shared';

export type InstanceAction =
  | 'start_requested'
  | 'startup_complete'
  | 'process_exited'
  | 'stop_requested'
  | 'kill_requested'
  | 'orphan_detected'
  | 'unmanageable'
  | 'mark_stopped'
  | 'recovered_stopped'
  | 'recovered_crashed';

const TABLE: Record<InstanceState, Partial<Record<InstanceAction, InstanceState>>> = {
  stopped: { start_requested: 'starting', recovered_stopped: 'stopped' },
  starting: { startup_complete: 'running', process_exited: 'crashed', recovered_crashed: 'crashed', recovered_stopped: 'stopped' },
  running: { stop_requested: 'stopping', process_exited: 'crashed', recovered_crashed: 'crashed', recovered_stopped: 'stopped' },
  stopping: { process_exited: 'stopped', kill_requested: 'stopping', recovered_crashed: 'crashed', recovered_stopped: 'stopped' },
  crashed: { start_requested: 'starting', mark_stopped: 'stopped', recovered_crashed: 'crashed', recovered_stopped: 'stopped' },
  orphaned: {
    stop_requested: 'stopping',
    kill_requested: 'stopped',
    unmanageable: 'unknown',
    recovered_crashed: 'crashed',
    recovered_stopped: 'stopped',
  },
  unknown: {
    kill_requested: 'stopped',
    mark_stopped: 'stopped',
    recovered_crashed: 'crashed',
    recovered_stopped: 'stopped',
  },
};

export function transition(current: InstanceState, action: InstanceAction): InstanceState | null {
  return TABLE[current][action] ?? null;
}
```

- [ ] **Step 4: 实现 InstanceSupervisor**

`apps/server/src/services/instance-supervisor.ts`：

```ts
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { ConsoleLine, InstanceState, InstanceStatusSnapshot, LogEncoding } from '@mcpanel/shared';
import type { DB } from '../db/client';
import { instances, type InstanceRow } from '../db/schema';
import { detectJava, type JavaInfo } from '../nodes/java-detect';
import { LocalNodeDriver } from '../nodes/local-driver';
import { isPortFree } from '../nodes/port-check';
import { isPidAlive, killPidTree } from '../nodes/process-tree';
import { AppError } from '../utils/errors';
import type { AuditService } from './audit-service';
import { ConsoleBuffer, classifyLevel } from './console-buffer';
import { loadServerProperties, propertyValue } from './properties-service';
import type { RconService } from './rcon-service';
import { transition } from './state-machine';

interface RuntimeState {
  state: InstanceState;
  pid: number | null;
  startedAt: number | null;
  exitCode: number | null;
  error: string | null;
}

export interface SupervisorDeps {
  db: DB;
  driver: LocalNodeDriver;
  rcon: RconService;
  audit: AuditService;
  logger: Logger;
  dataDir: string;
  detectJava?: (javaPath: string | null) => Promise<JavaInfo | null>;
  portFree?: (port: number) => Promise<boolean>;
}

const STARTUP_TIMEOUT_MS = 300_000;
const STARTUP_PATTERNS = [/Done \(/, /For help, type "help"/i, /Listening on \//i];
const FAILURE_HINTS: { pattern: RegExp; message: string }[] = [
  { pattern: /Failed to load eula\.txt/i, message: 'eula.txt 未接受或格式错误' },
  { pattern: /Address already in use/i, message: '端口已被占用' },
  { pattern: /UnsupportedClassVersionError/i, message: 'Java 版本过低' },
  { pattern: /Java heap space/i, message: 'Java 堆内存不足' },
];

export class InstanceSupervisor extends EventEmitter {
  private readonly runtime = new Map<string, RuntimeState>();
  private readonly buffers = new Map<string, ConsoleBuffer>();
  private readonly timers = new Map<string, NodeJS.Timeout[]>();
  private readonly locks = new Set<string>();
  private readonly commandTimes = new Map<string, number[]>();
  private closing = false;

  constructor(private readonly deps: SupervisorDeps) {
    super();
    this.deps.driver.on('output', (event: { instanceId: string; stream: 'stdout' | 'stderr'; text: string }) => {
      const line = this.getBuffer(event.instanceId).append({
        stream: event.stream,
        level: classifyLevel(event.text),
        text: event.text,
      });
      this.emit('console', event.instanceId, [line]);
      if (this.runtime.get(event.instanceId)?.state === 'starting') {
        if (STARTUP_PATTERNS.some((pattern) => pattern.test(event.text))) this.markRunning(event.instanceId);
      }
    });
    this.deps.driver.on('exit', (event: { instanceId: string; code: number | null }) => {
      this.handleExit(event.instanceId, event.code);
    });
  }

  async init(): Promise<void> {
    const rows = this.deps.db.select().from(instances).all();
    for (const row of rows) {
      this.runtime.set(row.id, {
        state: row.lastState,
        pid: row.lastPid,
        startedAt: row.lastStartedAt,
        exitCode: row.lastExitCode,
        error: row.lastError,
      });
    }
    for (const row of rows) await this.recover(row);
  }

  getStatus(instanceId: string): InstanceStatusSnapshot {
    const row = this.deps.db.select().from(instances).where(eq(instances.id, instanceId)).get();
    const state = this.runtime.get(instanceId);
    return {
      instanceId,
      state: state?.state ?? row?.lastState ?? 'stopped',
      pid: state?.pid ?? row?.lastPid ?? null,
      startedAt: state?.startedAt ? new Date(state.startedAt).toISOString() : null,
      exitCode: state?.exitCode ?? row?.lastExitCode ?? null,
      error: state?.error ?? row?.lastError ?? null,
    };
  }

  start(instanceId: string): Promise<InstanceStatusSnapshot> {
    return this.withLock(instanceId, () => this.startInternal(instanceId));
  }

  stop(instanceId: string): Promise<void> {
    return this.withLock(instanceId, () => this.stopInternal(instanceId));
  }

  restart(instanceId: string): Promise<void> {
    return this.withLock(instanceId, async () => {
      const state = this.requireRuntime(instanceId).state;
      if (!['running', 'orphaned', 'stopped', 'crashed'].includes(state)) {
        throw new AppError('INVALID_STATE', '当前状态无法重启');
      }
      if (state === 'running' || state === 'orphaned') await this.stopInternal(instanceId);
      await this.startInternal(instanceId);
    });
  }

  kill(instanceId: string): Promise<void> {
    return this.withLock(instanceId, async () => {
      const runtime = this.requireRuntime(instanceId);
      if (!runtime.pid) throw new AppError('INVALID_STATE', '没有可结束的进程');
      if (['running', 'starting', 'stopping'].includes(runtime.state)) {
        this.updateState(instanceId, 'stopping', {});
        try {
          await this.deps.driver.killProcessTree(instanceId);
        } catch (error) {
          if ((error as AppError).code !== 'INVALID_STATE') throw error;
        }
        if (this.requireRuntime(instanceId).state !== 'stopped') this.updateState(instanceId, 'stopped', {});
      } else if (['orphaned', 'unknown'].includes(runtime.state)) {
        try {
          await killPidTree(runtime.pid);
        } catch (error) {
          if (isPidAlive(runtime.pid)) throw error;
        }
        this.updateState(instanceId, 'stopped', {});
      } else {
        throw new AppError('INVALID_STATE', '当前状态无法强制结束');
      }
      this.deps.audit.record({ action: 'instance.kill', targetType: 'instance', targetId: instanceId });
    });
  }

  markStopped(instanceId: string): Promise<void> {
    return this.withLock(instanceId, async () => {
      const runtime = this.requireRuntime(instanceId);
      if (!['unknown', 'crashed'].includes(runtime.state)) throw new AppError('INVALID_STATE', '仅 unknown/crashed 可标记');
      if (runtime.pid && isPidAlive(runtime.pid)) throw new AppError('INVALID_STATE', '进程仍在运行，请先强制结束');
      this.updateState(instanceId, 'stopped', { pid: null, error: null });
      this.deps.audit.record({ action: 'instance.mark_stopped', targetType: 'instance', targetId: instanceId });
    });
  }

  async sendCommand(instanceId: string, command: string): Promise<void> {
    const row = this.getInstance(instanceId);
    const runtime = this.requireRuntime(instanceId);
    this.checkCommandRate(instanceId);
    if (runtime.state === 'running') {
      await this.deps.driver.writeStdin(instanceId, command);
      return;
    }
    if (runtime.state === 'orphaned') {
      const response = await this.deps.rcon.send(row, command);
      const line = this.getBuffer(instanceId).append({
        stream: 'rcon',
        level: 'info',
        text: response ? `> ${command}\n${response}` : `> ${command}`,
      });
      this.emit('console', instanceId, [line]);
      return;
    }
    throw new AppError('INVALID_STATE', '服务器未运行');
  }

  async getConsoleSnapshot(instanceId: string, sinceSeq?: number) {
    await this.ensureHistory(instanceId);
    return this.getBuffer(instanceId).since(sinceSeq);
  }

  async getRecentLines(instanceId: string, limit: number): Promise<ConsoleLine[]> {
    await this.ensureHistory(instanceId);
    return this.getBuffer(instanceId).snapshot().slice(-limit);
  }

  getLogFilePath(instanceId: string): string {
    return path.join(this.getInstance(instanceId).rootPath, 'logs', 'latest.log');
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    for (const timers of this.timers.values()) {
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
    }
    this.timers.clear();
    this.deps.rcon.closeAll();
  }

  private async startInternal(instanceId: string): Promise<InstanceStatusSnapshot> {
    const row = this.getInstance(instanceId);
    const runtime = this.requireRuntime(instanceId);
    if (!['stopped', 'crashed'].includes(runtime.state)) {
      throw new AppError('INVALID_STATE', `当前状态 ${runtime.state} 不能启动`);
    }
    await this.validateStart(row);
    this.updateState(instanceId, transition(runtime.state, 'start_requested')!, {
      pid: null,
      startedAt: Date.now(),
      exitCode: null,
      error: null,
    });
    try {
      const snapshot = await this.deps.driver.startProcess({
        instanceId,
        rootPath: row.rootPath,
        startCommand: row.startCommand,
        logEncoding: row.logEncoding as LogEncoding,
      });
      this.updateState(instanceId, this.requireRuntime(instanceId).state, {
        pid: snapshot.pid,
        startedAt: snapshot.startedAt,
      });
      this.scheduleStartupChecks(row);
      this.deps.audit.record({ action: 'instance.start', targetType: 'instance', targetId: instanceId });
      return this.getStatus(instanceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateState(instanceId, 'crashed', { error: message });
      throw new AppError('INTERNAL', `启动失败：${message}`);
    }
  }

  private async validateStart(row: InstanceRow): Promise<void> {
    try {
      await fs.access(row.rootPath);
    } catch {
      throw new AppError('INVALID_ROOT', '实例目录不存在');
    }
    try {
      const eula = await fs.readFile(path.join(row.rootPath, 'eula.txt'), 'utf8');
      if (!/^\s*eula\s*=\s*true\s*$/im.test(eula)) throw new AppError('EULA_NOT_ACCEPTED', '请先接受 EULA');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const java = await (this.deps.detectJava ?? detectJava)(row.javaPath);
    if (!java) throw new AppError('JAVA_NOT_FOUND', '找不到可用的 Java');
    const parsed = (await loadServerProperties(row.rootPath))?.parsed ?? null;
    const free = this.deps.portFree ?? isPortFree;
    const serverPort = Number(propertyValue(parsed, 'server-port', '25565')) || 25565;
    if (!(await free(serverPort))) throw new AppError('PORT_IN_USE', `端口 ${serverPort} 已被占用`, { port: serverPort });
    if (propertyValue(parsed, 'enable-rcon', 'false') === 'true') {
      const rconPort = Number(propertyValue(parsed, 'rcon.port', '25575')) || 25575;
      if (!(await free(rconPort))) throw new AppError('PORT_IN_USE', `RCON 端口 ${rconPort} 已被占用`, { port: rconPort });
    }
  }

  private async stopInternal(instanceId: string): Promise<void> {
    const row = this.getInstance(instanceId);
    const runtime = this.requireRuntime(instanceId);
    if (runtime.state === 'running') {
      this.updateState(instanceId, 'stopping', {});
      const result = await this.deps.driver.stopProcess(instanceId, row.stopTimeoutSec);
      if (result.forced) {
        this.deps.audit.record({ action: 'instance.force_stop', targetType: 'instance', targetId: instanceId });
      }
      if (this.requireRuntime(instanceId).state !== 'stopped') this.updateState(instanceId, 'stopped', {});
      this.deps.audit.record({ action: 'instance.stop', targetType: 'instance', targetId: instanceId });
      return;
    }
    if (runtime.state === 'orphaned') {
      if (!runtime.pid) throw new AppError('INVALID_STATE', '没有记录到进程 PID');
      const pid = runtime.pid;
      this.updateState(instanceId, 'stopping', {});
      try {
        await this.deps.rcon.send(row, 'stop');
      } catch {
        this.updateState(instanceId, 'unknown', { error: 'RCON 失联，无法停止服务器' });
        throw new AppError('RCON_UNAVAILABLE', 'RCON 失联，无法停止服务器');
      }
      const stopped = await waitForCondition(() => !isPidAlive(pid), 60_000);
      if (!stopped) {
        this.updateState(instanceId, 'unknown', { error: '服务器未在 60 秒内退出' });
        throw new AppError('INVALID_STATE', '服务器未在 60 秒内退出');
      }
      this.updateState(instanceId, 'stopped', {});
      this.deps.audit.record({ action: 'instance.stop', targetType: 'instance', targetId: instanceId });
      return;
    }
    throw new AppError('INVALID_STATE', `当前状态 ${runtime.state} 不能停止`);
  }

  private handleExit(instanceId: string, code: number | null): void {
    const runtime = this.runtime.get(instanceId);
    if (!runtime || this.closing) return;
    this.clearTimers(instanceId);
    if (runtime.state === 'stopping') {
      this.updateState(instanceId, 'stopped', { exitCode: code, pid: null });
      return;
    }
    if (runtime.state === 'starting' || runtime.state === 'running') {
      const lines = this.getBuffer(instanceId).snapshot().slice(-200).map((line) => line.text);
      const hint = FAILURE_HINTS.find((item) => lines.some((line) => item.pattern.test(line)));
      this.updateState(instanceId, 'crashed', {
        exitCode: code,
        pid: null,
        error: hint?.message ?? `进程退出，退出码 ${code ?? 'unknown'}`,
      });
      this.deps.audit.record({ action: 'instance.crash', targetType: 'instance', targetId: instanceId, detail: { exitCode: code } });
      return;
    }
    this.updateState(instanceId, 'stopped', { exitCode: code, pid: null });
  }

  private scheduleStartupChecks(row: InstanceRow): void {
    const fallback = setTimeout(() => {
      if (this.runtime.get(row.id)?.state === 'starting') {
        this.updateState(row.id, 'running', { error: '未检测到启动完成标记，已按 300 秒超时判定为运行中' });
        this.clearTimers(row.id);
      }
    }, STARTUP_TIMEOUT_MS);
    const poll = setInterval(() => {
      void (async () => {
        if (this.runtime.get(row.id)?.state !== 'starting') {
          this.clearTimers(row.id);
          return;
        }
        const probe = await this.deps.rcon.test(row).catch(() => null);
        if (probe?.status === 'connected') this.markRunning(row.id);
      })();
    }, 5000);
    this.timers.set(row.id, [fallback, poll]);
  }

  private markRunning(instanceId: string): void {
    if (this.runtime.get(instanceId)?.state !== 'starting') return;
    this.clearTimers(instanceId);
    this.updateState(instanceId, 'running', { error: null });
  }

  private async recover(row: InstanceRow): Promise<void> {
    const runtime = this.requireRuntime(row.id);
    if (runtime.state === 'stopped') return;
    if (row.lastPid) {
      if (!isPidAlive(row.lastPid)) {
        const next = ['starting', 'running', 'stopping'].includes(runtime.state) ? 'crashed' : 'stopped';
        this.updateState(row.id, next, { pid: null, error: next === 'crashed' ? '面板重启后进程已不存在' : null });
        return;
      }
      const verified = await this.deps.driver.verifyPid(row.lastPid, row.rootPath).catch(() => true);
      if (!verified) {
        const next = ['starting', 'running', 'stopping'].includes(runtime.state) ? 'crashed' : 'stopped';
        this.updateState(row.id, next, { pid: null, error: next === 'crashed' ? 'PID 已被其他进程复用' : null });
        return;
      }
      const probe = await this.deps.rcon.test(row).catch(() => null);
      if (probe?.status === 'connected') {
        this.updateState(row.id, 'orphaned', { error: null });
        this.deps.audit.record({ action: 'instance.recover_orphan', targetType: 'instance', targetId: row.id });
      } else {
        this.updateState(row.id, 'unknown', { error: '进程仍在运行但 RCON 不可用，请强制结束或手动确认' });
      }
      return;
    }
    if (['crashed', 'unknown'].includes(runtime.state)) return;
    if (['starting', 'running', 'stopping', 'orphaned'].includes(runtime.state)) {
      this.updateState(row.id, 'crashed', { error: '面板重启后进程记录丢失' });
    }
  }

  private async ensureHistory(instanceId: string): Promise<void> {
    const buffer = this.getBuffer(instanceId);
    if (buffer.size > 0) return;
    const row = this.getInstance(instanceId);
    for (const text of (await this.deps.driver.readLogTail(row.rootPath, row.logEncoding as LogEncoding)).slice(-1000)) {
      buffer.append({ stream: 'stdout', level: classifyLevel(text), text });
    }
  }

  private getBuffer(instanceId: string): ConsoleBuffer {
    let buffer = this.buffers.get(instanceId);
    if (!buffer) {
      buffer = new ConsoleBuffer();
      this.buffers.set(instanceId, buffer);
    }
    return buffer;
  }

  private getInstance(instanceId: string): InstanceRow {
    const row = this.deps.db.select().from(instances).where(eq(instances.id, instanceId)).get();
    if (!row) throw new AppError('NOT_FOUND', '实例不存在');
    return row;
  }

  private requireRuntime(instanceId: string): RuntimeState {
    const runtime = this.runtime.get(instanceId);
    if (!runtime) throw new AppError('NOT_FOUND', '实例不存在');
    return runtime;
  }

  private updateState(instanceId: string, next: InstanceState, patch: Partial<RuntimeState>): void {
    const updated = { ...this.requireRuntime(instanceId), ...patch, state: next };
    this.runtime.set(instanceId, updated);
    this.deps.db
      .update(instances)
      .set({
        lastState: next,
        lastPid: updated.pid,
        lastStartedAt: updated.startedAt,
        lastExitCode: updated.exitCode,
        lastError: updated.error,
        updatedAt: Date.now(),
      })
      .where(eq(instances.id, instanceId))
      .run();
    this.emit('state', this.getStatus(instanceId));
  }

  private clearTimers(instanceId: string): void {
    for (const timer of this.timers.get(instanceId) ?? []) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers.delete(instanceId);
  }

  private async withLock<T>(instanceId: string, task: () => Promise<T>): Promise<T> {
    if (this.locks.has(instanceId)) throw new AppError('OPERATION_IN_PROGRESS', '实例已有操作在执行');
    this.locks.add(instanceId);
    try {
      return await task();
    } finally {
      this.locks.delete(instanceId);
    }
  }

  private checkCommandRate(instanceId: string): void {
    const now = Date.now();
    const recent = (this.commandTimes.get(instanceId) ?? []).filter((time) => now - time < 60_000);
    if (recent.length >= 30) throw new AppError('COMMAND_RATE_LIMITED', '命令发送过快，请稍后再试');
    recent.push(now);
    this.commandTimes.set(instanceId, recent);
  }
}

async function waitForCondition(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return predicate();
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -w @mcpanel/server -- test/unit/state-machine.test.ts test/integration/supervisor.test.ts`
Expected: state machine 2 个测试 PASS；supervisor 2 个测试 PASS。若 Vitest 不退出，检查所有 supervisor 是否在 `afterEach` 中 `shutdown()`，且启动定时器在 `markRunning` 时被清理。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/services/state-machine.ts apps/server/src/services/instance-supervisor.ts apps/server/test/unit/state-machine.test.ts apps/server/test/integration/supervisor.test.ts
git commit -m "feat(server): add instance state machine and supervisor with orphan recovery"
```

---

## Task 10: Fastify 骨架、认证路由、CSRF、限流与错误处理

**Files:**
- Create: `apps/server/src/types/fastify.d.ts`, `apps/server/src/auth/guard.ts`, `apps/server/src/routes/auth.ts`, `apps/server/src/app.ts`
- Test: `apps/server/test/helpers/http.ts`, `apps/server/test/unit/login-throttle.test.ts`, `apps/server/test/integration/auth-routes.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/server/test/helpers/http.ts`：

```ts
import type { LightMyRequestResponse } from 'fastify';

export class CookieJar {
  private readonly jar = new Map<string, string>();

  absorb(response: LightMyRequestResponse): void {
    const raw = response.headers['set-cookie'];
    const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const cookie of cookies) {
      const pair = cookie.split(';')[0];
      const separator = pair.indexOf('=');
      if (separator > 0) this.jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }

  header(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

export function json<T>(response: LightMyRequestResponse): T {
  return response.json() as T;
}
```

`apps/server/test/unit/login-throttle.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { LoginThrottle } from '../../src/auth/guard';

describe('LoginThrottle', () => {
  it('locks after 10 failures for 15 minutes and resets after success', () => {
    let now = 0;
    const throttle = new LoginThrottle(() => now);
    for (let index = 0; index < 9; index += 1) {
      throttle.assertAllowed('1.2.3.4');
      throttle.recordFailure('1.2.3.4');
    }
    throttle.assertAllowed('1.2.3.4');
    throttle.recordFailure('1.2.3.4');
    expect(() => throttle.assertAllowed('1.2.3.4')).toThrow(/15/);
    now += 15 * 60 * 1000 + 1;
    expect(() => throttle.assertAllowed('1.2.3.4')).not.toThrow();

    throttle.recordFailure('5.6.7.8');
    throttle.recordSuccess('5.6.7.8');
    for (let index = 0; index < 9; index += 1) throttle.recordFailure('5.6.7.8');
    expect(() => throttle.assertAllowed('5.6.7.8')).not.toThrow();
  });
});
```

`apps/server/test/integration/auth-routes.test.ts`：

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { SessionService } from '../../src/auth/session';
import { LoginThrottle } from '../../src/auth/guard';
import { loadConfig } from '../../src/config';
import { silentLogger } from '../../src/logger';
import { AuditService } from '../../src/services/audit-service';
import { createTestDb, type TestDb } from '../helpers/db';
import { CookieJar, json } from '../helpers/http';

let ctx: TestDb;

async function makeApp() {
  ctx = createTestDb();
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: ctx.dir });
  const services = {
    sessions: new SessionService(ctx.db),
    audit: new AuditService(ctx.db),
    loginThrottle: new LoginThrottle(),
  };
  const app = await buildApp(config, ctx.db, services, { logger: silentLogger() });
  return { app, services };
}

function origin() {
  return { origin: 'http://localhost:80' };
}

afterEach(async () => {
  ctx?.close();
});

describe('auth routes', () => {
  it('runs setup, status, logout and rejects a second setup', async () => {
    const { app } = await makeApp();
    const jar = new CookieJar();

    let csrf = await app.inject({ method: 'GET', url: '/api/auth/csrf' });
    jar.absorb(csrf);
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { ...origin(), cookie: jar.header(), 'x-csrf-token': json<{ token: string }>(csrf).token },
      payload: { username: 'admin', password: 'longpassword12' },
    });
    expect(setup.statusCode).toBe(200);
    jar.absorb(setup);

    const status = await app.inject({ method: 'GET', url: '/api/auth/status', headers: { cookie: jar.header() } });
    expect(json<{ setupRequired: boolean; authenticated: boolean }>(status)).toMatchObject({
      setupRequired: false,
      authenticated: true,
    });

    csrf = await app.inject({ method: 'GET', url: '/api/auth/csrf' });
    jar.absorb(csrf);
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...origin(), cookie: jar.header(), 'x-csrf-token': json<{ token: string }>(csrf).token },
    });
    expect(logout.statusCode).toBe(204);

    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { ...origin(), cookie: jar.header(), 'x-csrf-token': json<{ token: string }>(csrf).token },
      payload: { username: 'other', password: 'longpassword12' },
    });
    expect(second.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(second).error.code).toBe('SETUP_COMPLETED');
  });

  it('logs in, rejects bad credentials and enforces CSRF and auth', async () => {
    const { app } = await makeApp();
    const jar = new CookieJar();
    let csrf = await app.inject({ method: 'GET', url: '/api/auth/csrf' });
    jar.absorb(csrf);
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { ...origin(), cookie: jar.header(), 'x-csrf-token': json<{ token: string }>(csrf).token },
      payload: { username: 'admin', password: 'longpassword12' },
    });
    expect(setup.statusCode).toBe(200);
    jar.absorb(setup);

    const loginCsrf = await app.inject({ method: 'GET', url: '/api/auth/csrf' });
    jar.absorb(loginCsrf);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...origin(), cookie: jar.header(), 'x-csrf-token': json<{ token: string }>(loginCsrf).token },
      payload: { username: 'admin', password: 'wrongpassword' },
    });
    expect(bad.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(bad).error.code).toBe('INVALID_CREDENTIALS');

    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...origin(), cookie: jar.header() },
      payload: { username: 'admin', password: 'longpassword12' },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(noCsrf).error.code).toBe('CSRF_INVALID');

    const good = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...origin(), cookie: jar.header(), 'x-csrf-token': json<{ token: string }>(loginCsrf).token },
      payload: { username: 'admin', password: 'longpassword12' },
    });
    expect(good.statusCode).toBe(200);
    jar.absorb(good);

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: jar.header() } });
    expect(me.statusCode).toBe(200);
    expect(json<{ user: { username: string } }>(me).user.username).toBe('admin');

    const anonymous = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(anonymous.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/server -- test/unit/login-throttle.test.ts test/integration/auth-routes.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 guard 与类型声明**

`apps/server/src/types/fastify.d.ts`：

```ts
import type { UserRow } from '../db/schema';

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow | null;
    sessionToken: string | null;
  }
}
```

`apps/server/src/auth/guard.ts`：

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE } from '@mcpanel/shared';
import type { SessionService } from './session';
import { AppError } from '../utils/errors';

const LOCK_MS = 15 * 60 * 1000;

export class LoginThrottle {
  private readonly entries = new Map<string, { failures: number; lockedUntil: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  assertAllowed(ip: string): void {
    const entry = this.entries.get(ip);
    if (!entry?.lockedUntil) return;
    if (entry.lockedUntil > this.now()) {
      const minutes = Math.ceil((entry.lockedUntil - this.now()) / 60_000);
      throw new AppError('LOGIN_RATE_LIMITED', `登录失败次数过多，请 ${minutes} 分钟后重试`);
    }
    this.entries.delete(ip);
  }

  recordFailure(ip: string): void {
    const entry = this.entries.get(ip) ?? { failures: 0, lockedUntil: 0 };
    entry.failures += 1;
    if (entry.failures >= 10) {
      entry.failures = 0;
      entry.lockedUntil = this.now() + LOCK_MS;
    }
    this.entries.set(ip, entry);
  }

  recordSuccess(ip: string): void {
    this.entries.delete(ip);
  }
}

export function createGuards(app: FastifyInstance, sessions: SessionService) {
  const requireAuth = async (request: FastifyRequest): Promise<void> => {
    const token = request.cookies[SESSION_COOKIE];
    const resolved = token ? sessions.resolve(token) : null;
    if (!token || !resolved) throw new AppError('AUTH_REQUIRED', '请先登录');
    request.user = resolved.user;
    request.sessionToken = token;
  };

  const requireOrigin = async (request: FastifyRequest): Promise<void> => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    const source = request.headers.origin ?? request.headers.referer;
    if (!source) throw new AppError('FORBIDDEN', '缺少来源信息');
    let host: string;
    try {
      host = new URL(source).host;
    } catch {
      throw new AppError('FORBIDDEN', '来源校验失败');
    }
    if (host !== request.headers.host) throw new AppError('FORBIDDEN', '来源校验失败');
  };

  const setSessionCookie = (reply: FastifyReply, token: string, secure: boolean): void => {
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: 7 * 24 * 60 * 60,
    });
  };

  return { requireAuth, requireOrigin, setSessionCookie };
}
```

- [ ] **Step 4: 实现认证路由**

`apps/server/src/routes/auth.ts`：

```ts
import { randomUUID } from 'node:crypto';
import { count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { changePasswordSchema, loginSchema, setupSchema, SESSION_COOKIE, type AuthStatus, type UserInfo } from '@mcpanel/shared';
import type { AppConfig } from '../config';
import type { DB } from '../db/client';
import { users } from '../db/schema';
import { hashPassword, verifyPassword } from '../auth/password';
import { createGuards, type LoginThrottle } from '../auth/guard';
import type { SessionService } from '../auth/session';
import type { AuditService } from '../services/audit-service';
import { AppError } from '../utils/errors';

export interface AuthRouteDeps {
  config: AppConfig;
  db: DB;
  sessions: SessionService;
  audit: AuditService;
  loginThrottle: LoginThrottle;
}

function toUserInfo(row: { id: string; username: string; role: 'admin' }): UserInfo {
  return { id: row.id, username: row.username, role: row.role };
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { config, db, sessions, audit, loginThrottle } = deps;
  const guards = createGuards(app, sessions);
  const userCount = () => db.select({ value: count() }).from(users).get()?.value ?? 0;

  app.get('/api/auth/status', async (request): Promise<AuthStatus> => {
    if (userCount() === 0) return { setupRequired: true, authenticated: false, user: null };
    const token = request.cookies[SESSION_COOKIE];
    const resolved = token ? sessions.resolve(token) : null;
    return {
      setupRequired: false,
      authenticated: Boolean(resolved),
      user: resolved ? toUserInfo(resolved.user) : null,
    };
  });

  app.get('/api/auth/csrf', async (_request, reply) => {
    return { token: await reply.generateCsrf() };
  });

  app.post('/api/auth/setup', { preHandler: [guards.requireOrigin, app.csrfProtection] }, async (request, reply) => {
    const input = setupSchema.parse(request.body);
    if (userCount() > 0) throw new AppError('SETUP_COMPLETED', '面板已初始化');
    const passwordHash = await hashPassword(input.password);
    const id = randomUUID();
    const now = Date.now();
    db.insert(users).values({ id, username: input.username, passwordHash, role: 'admin', createdAt: now, updatedAt: now }).run();
    const { token } = sessions.create(id, request.ip, request.headers['user-agent'] ?? null);
    guards.setSessionCookie(reply, token, config.cookieSecure);
    audit.record({ userId: id, action: 'setup.complete', targetType: 'user', targetId: id, ip: request.ip });
    return { user: toUserInfo({ id, username: input.username, role: 'admin' }) };
  });

  app.post(
    '/api/auth/login',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      preHandler: [guards.requireOrigin, app.csrfProtection],
    },
    async (request, reply) => {
      const input = loginSchema.parse(request.body);
      loginThrottle.assertAllowed(request.ip);
      const row = db.select().from(users).where(eq(users.username, input.username)).get();
      const valid = row ? await verifyPassword(row.passwordHash, input.password) : false;
      if (!row || !valid) {
        loginThrottle.recordFailure(request.ip);
        audit.record({
          action: 'auth.login_failed',
          targetType: 'user',
          targetId: row?.id ?? null,
          detail: { username: input.username },
          ip: request.ip,
        });
        throw new AppError('INVALID_CREDENTIALS', '用户名或密码错误');
      }
      loginThrottle.recordSuccess(request.ip);
      const { token } = sessions.create(row.id, request.ip, request.headers['user-agent'] ?? null);
      guards.setSessionCookie(reply, token, config.cookieSecure);
      audit.record({ userId: row.id, action: 'auth.login', targetType: 'user', targetId: row.id, ip: request.ip });
      return { user: toUserInfo(row) };
    },
  );

  app.post(
    '/api/auth/logout',
    { preHandler: [guards.requireOrigin, guards.requireAuth, app.csrfProtection] },
    async (request, reply) => {
      if (request.sessionToken) sessions.delete(request.sessionToken);
      audit.record({
        userId: request.user?.id,
        action: 'auth.logout',
        targetType: 'user',
        targetId: request.user?.id ?? null,
        ip: request.ip,
      });
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return reply.status(204).send();
    },
  );

  app.get('/api/auth/me', { preHandler: [guards.requireAuth] }, async (request) => {
    return { user: toUserInfo(request.user!) };
  });

  app.post(
    '/api/auth/password',
    { preHandler: [guards.requireOrigin, guards.requireAuth, app.csrfProtection] },
    async (request) => {
      const input = changePasswordSchema.parse(request.body);
      const user = request.user!;
      if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
        throw new AppError('VALIDATION_ERROR', '当前密码错误', { field: 'currentPassword' });
      }
      const passwordHash = await hashPassword(input.newPassword);
      db.update(users).set({ passwordHash, updatedAt: Date.now() }).where(eq(users.id, user.id)).run();
      sessions.deleteOtherSessions(user.id, request.sessionToken!);
      audit.record({ userId: user.id, action: 'auth.password_change', targetType: 'user', targetId: user.id, ip: request.ip });
      return { ok: true };
    },
  );
}
```

- [ ] **Step 5: 实现 app.ts**

`apps/server/src/app.ts`：

```ts
import cookie from '@fastify/cookie';
import csrf from '@fastify/csrf-protection';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import { PANEL_VERSION } from '@mcpanel/shared';
import type { AppConfig } from './config';
import type { DB } from './db/client';
import { silentLogger } from './logger';
import { registerAuthRoutes } from './routes/auth';
import type { AuditService } from './services/audit-service';
import type { SessionService } from './auth/session';
import type { LoginThrottle } from './auth/guard';
import { AppError } from './utils/errors';

export interface AppServices {
  sessions: SessionService;
  audit: AuditService;
  loginThrottle: LoginThrottle;
}

export interface BuildAppOptions {
  logger?: Logger;
}

export async function buildApp(
  config: AppConfig,
  db: DB,
  services: AppServices,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: options.logger ?? silentLogger(),
    trustProxy: config.trustProxy,
  });

  await app.register(cookie);
  await app.register(csrf);
  await app.register(rateLimit, { global: false });

  app.decorateRequest('user', null);
  app.decorateRequest('sessionToken', null);

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'",
    );
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.status).send({
        error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
      });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: '参数校验失败', details: error.issues },
      });
    }
    const code = (error as { code?: string }).code ?? '';
    if (code.startsWith('FST_CSRF') || /csrf/i.test(error.message)) {
      return reply.status(403).send({ error: { code: 'CSRF_INVALID', message: 'CSRF token 缺失或无效' } });
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.status(429).send({ error: { code: 'LOGIN_RATE_LIMITED', message: '请求过于频繁' } });
    }
    request.log.error({ err: error }, 'request failed');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: '资源不存在' } });
  });

  app.get('/api/health', async () => ({ ok: true, version: PANEL_VERSION }));

  registerAuthRoutes(app, {
    config,
    db,
    sessions: services.sessions,
    audit: services.audit,
    loginThrottle: services.loginThrottle,
  });

  return app;
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npm test -w @mcpanel/server -- test/unit/login-throttle.test.ts test/integration/auth-routes.test.ts`
Expected: 2 个文件共 3 个测试 PASS。若 `reply.generateCsrf` 不存在或类型报错，确认 `@fastify/csrf-protection` 已在 `cookie` 之后注册；若错误处理没有返回 `CSRF_INVALID`，打印插件抛出的 `code` 并把它加入映射。

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/types apps/server/src/auth/guard.ts apps/server/src/routes/auth.ts apps/server/src/app.ts apps/server/test/helpers/http.ts apps/server/test/unit/login-throttle.test.ts apps/server/test/integration/auth-routes.test.ts
git commit -m "feat(server): add fastify app, auth routes, csrf and login throttling"
```

---

## Task 11: 实例服务与实例/审计 API

**Files:**
- Create: `apps/server/src/services/instance-service.ts`, `apps/server/src/services/instance-serializer.ts`, `apps/server/src/routes/instances.ts`, `apps/server/src/routes/audit.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/integration/instances-api.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/server/test/integration/instances-api.test.ts`：

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app';
import { insertUser } from '../helpers/factory';
import { SessionService } from '../../src/auth/session';
import { LoginThrottle } from '../../src/auth/guard';
import { loadConfig } from '../../src/config';
import { silentLogger } from '../../src/logger';
import { LocalNodeDriver } from '../../src/nodes/local-driver';
import { PathSandbox } from '../../src/nodes/path-sandbox';
import { AuditService } from '../../src/services/audit-service';
import { InstanceService } from '../../src/services/instance-service';
import { ProbeService } from '../../src/services/probe-service';
import { RconService } from '../../src/services/rcon-service';
import type { InstanceSupervisor } from '../../src/services/instance-supervisor';
import { createTestDb, type TestDb } from '../helpers/db';
import { CookieJar, json } from '../helpers/http';

let ctx: TestDb;
const roots: string[] = [];

async function makeApp() {
  ctx = createTestDb();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-api-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'eula.txt'), 'eula=true\n');
  await fs.writeFile(path.join(root, 'run.bat'), '@echo off');

  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: ctx.dir });
  const sessions = new SessionService(ctx.db);
  const userId = insertUser(ctx.db);
  const { token } = sessions.create(userId, null, null);
  const driver = new LocalNodeDriver(new PathSandbox(ctx.dir));
  const supervisor = {
    getStatus: (instanceId: string) => ({
      instanceId,
      state: 'stopped',
      pid: null,
      startedAt: null,
      exitCode: null,
      error: null,
    }),
    start: vi.fn(async () => ({})),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    kill: vi.fn(async () => undefined),
    markStopped: vi.fn(async () => undefined),
    sendCommand: vi.fn(async () => undefined),
    getRecentLines: vi.fn(async () => []),
    getLogFilePath: (instanceId: string) => path.join(ctx.dir, `${instanceId}.log`),
  } as unknown as InstanceSupervisor;

  const services = {
    sessions,
    audit: new AuditService(ctx.db),
    loginThrottle: new LoginThrottle(),
    supervisor,
    rcon: new RconService(),
    driver,
    probe: new ProbeService(new PathSandbox(ctx.dir), async () => ({ path: 'java', major: 21 })),
    instances: new InstanceService(ctx.db, ctx.dir),
  };
  const app = await buildApp(config, ctx.db, services, { logger: silentLogger() });

  const jar = new CookieJar();
  const csrf = await app.inject({ method: 'GET', url: '/api/auth/csrf' });
  jar.absorb(csrf);
  jar.set('mcpanel_session', token);
  return { app, root, jar, csrfToken: json<{ token: string }>(csrf).token, supervisor };
}

const origin = { origin: 'http://localhost:80' };

afterEach(async () => {
  ctx?.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('instances API', () => {
  it('probes, creates, lists, updates, runs actions and deletes', async () => {
    const { app, root, jar, csrfToken, supervisor } = await makeApp();
    const headers = { ...origin, cookie: jar.header(), 'x-csrf-token': csrfToken };

    const probe = await app.inject({ method: 'POST', url: '/api/instances/probe', headers, payload: { rootPath: root } });
    expect(probe.statusCode).toBe(200);
    expect(json<{ suggestedStartCommand: string }>(probe).suggestedStartCommand).toBe('run.bat');

    const created = await app.inject({
      method: 'POST',
      url: '/api/instances',
      headers,
      payload: { name: '生存服', rootPath: root, startCommand: 'run.bat' },
    });
    expect(created.statusCode).toBe(201);
    const instance = json<{ id: string; name: string }>(created);

    const list = await app.inject({ method: 'GET', url: '/api/instances', headers: { cookie: jar.header() } });
    expect(json<{ items: unknown[] }>(list).items).toHaveLength(1);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/instances/${instance.id}`,
      headers,
      payload: { name: '生存服 2', stopTimeoutSec: 45 },
    });
    expect(patched.statusCode).toBe(200);
    expect(json<{ name: string }>(patched).name).toBe('生存服 2');

    const started = await app.inject({ method: 'POST', url: `/api/instances/${instance.id}/actions/start`, headers });
    expect(started.statusCode).toBe(202);
    expect(supervisor.start).toHaveBeenCalledWith(instance.id);

    const command = await app.inject({
      method: 'POST',
      url: `/api/instances/${instance.id}/console/command`,
      headers,
      payload: { command: 'say hi' },
    });
    expect(command.statusCode).toBe(200);
    expect(supervisor.sendCommand).toHaveBeenCalledWith(instance.id, 'say hi');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/instances/${instance.id}`,
      headers,
      payload: { confirmName: '生存服 2' },
    });
    expect(deleted.statusCode).toBe(204);
    expect(await fs.readdir(root)).toContain('run.bat');
  });

  it('rejects duplicate roots and unauthenticated access', async () => {
    const { app, root, jar, csrfToken } = await makeApp();
    const headers = { ...origin, cookie: jar.header(), 'x-csrf-token': csrfToken };
    const payload = { name: 'A', rootPath: root, startCommand: 'run.bat' };
    expect((await app.inject({ method: 'POST', url: '/api/instances', headers, payload })).statusCode).toBe(201);
    const duplicate = await app.inject({ method: 'POST', url: '/api/instances', headers, payload: { ...payload, name: 'B' } });
    expect(duplicate.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(duplicate).error.code).toBe('ROOT_OVERLAPS');

    const anonymous = await app.inject({ method: 'GET', url: '/api/instances' });
    expect(anonymous.statusCode).toBe(401);
  });
});
```

在 `apps/server/test/helpers/http.ts` 的 `CookieJar` 中补一个方法：

```ts
set(name: string, value: string): void {
  this.jar.set(name, value);
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/server -- test/integration/instances-api.test.ts`
Expected: FAIL，`Cannot find module '../../src/services/instance-service'`。

- [ ] **Step 3: 实现实例服务与序列化**

`apps/server/src/services/instance-service.ts`：

```ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { createInstanceSchema, RootValidation, updateInstanceSchema } from '@mcpanel/shared';
import type { DB } from '../db/client';
import { instances, type InstanceRow } from '../db/schema';
import { AppError } from '../utils/errors';

export type CreateInstanceInput = z.infer<typeof createInstanceSchema>;
export type UpdateInstanceInput = z.infer<typeof updateInstanceSchema>;

export class InstanceService {
  constructor(
    private readonly db: DB,
    private readonly dataDir: string,
  ) {}

  list(): InstanceRow[] {
    return this.db.select().from(instances).orderBy(instances.createdAt).all();
  }

  get(instanceId: string): InstanceRow {
    const row = this.db.select().from(instances).where(eq(instances.id, instanceId)).get();
    if (!row) throw new AppError('NOT_FOUND', '实例不存在');
    return row;
  }

  create(input: CreateInstanceInput, root: RootValidation): InstanceRow {
    this.assertNameAvailable(input.name);
    const existing = this.db.select().from(instances).where(eq(instances.rootPathKey, root.rootKey)).get();
    if (existing) throw new AppError('ROOT_OVERLAPS', '该目录已被其他实例纳管');
    const now = Date.now();
    const row: InstanceRow = {
      id: crypto.randomUUID(),
      nodeId: 'local',
      name: input.name,
      rootPath: root.realPath,
      rootPathKey: root.rootKey,
      startCommand: input.startCommand,
      javaPath: input.javaPath,
      stopTimeoutSec: input.stopTimeoutSec,
      logEncoding: input.logEncoding,
      rconHost: input.rconHost,
      backupKeep: input.backupKeep,
      backupIncludeMods: input.backupIncludeMods,
      backupIncludeConfig: input.backupIncludeConfig,
      backupExtraPaths: JSON.stringify(input.backupExtraPaths),
      lastState: 'stopped',
      lastPid: null,
      lastStartedAt: null,
      lastExitCode: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(instances).values(row).run();
    return row;
  }

  update(instanceId: string, patch: UpdateInstanceInput): InstanceRow {
    this.get(instanceId);
    if (patch.name) this.assertNameAvailable(patch.name, instanceId);
    const { backupExtraPaths, ...rest } = patch;
    const values: Partial<typeof instances.$inferInsert> = { ...rest, updatedAt: Date.now() };
    if (backupExtraPaths) values.backupExtraPaths = JSON.stringify(backupExtraPaths);
    this.db.update(instances).set(values).where(eq(instances.id, instanceId)).run();
    return this.get(instanceId);
  }

  delete(row: InstanceRow, confirmName: string): void {
    if (confirmName !== row.name) throw new AppError('VALIDATION_ERROR', '实例名称不匹配');
    if (!['stopped', 'crashed'].includes(row.lastState)) {
      throw new AppError('INVALID_STATE', '请先停止服务器并确认进程已结束');
    }
    const tmpDir = path.join(row.rootPath, '.mcpanel-tmp');
    if (fs.existsSync(tmpDir)) {
      const leftovers = fs.readdirSync(tmpDir).filter((name) => name.startsWith('rollback-'));
      if (leftovers.length > 0) throw new AppError('INVALID_STATE', '存在恢复残留，请先处理');
    }
    fs.rmSync(path.join(this.dataDir, 'backups', row.id), { recursive: true, force: true });
    this.db.delete(instances).where(eq(instances.id, row.id)).run();
  }

  private assertNameAvailable(name: string, excludeId?: string): void {
    const rows = this.db
      .select()
      .from(instances)
      .where(sql`lower(${instances.name}) = lower(${name})`)
      .all();
    const conflict = rows.find((row) => row.id !== excludeId);
    if (conflict) throw new AppError('VALIDATION_ERROR', '实例名称已存在', { field: 'name' });
  }
}
```

`apps/server/src/services/instance-serializer.ts`：

```ts
import type { InstanceInfo, InstanceStatusSnapshot, RconStatus } from '@mcpanel/shared';
import type { InstanceRow } from '../db/schema';

export function parseExtraPaths(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function toInstanceInfo(row: InstanceRow, status: InstanceStatusSnapshot, rconStatus: RconStatus): InstanceInfo {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.rootPath,
    startCommand: row.startCommand,
    javaPath: row.javaPath,
    stopTimeoutSec: row.stopTimeoutSec,
    logEncoding: row.logEncoding,
    rconHost: row.rconHost,
    backupKeep: row.backupKeep,
    backupIncludeMods: row.backupIncludeMods,
    backupIncludeConfig: row.backupIncludeConfig,
    backupExtraPaths: parseExtraPaths(row.backupExtraPaths),
    state: status.state,
    pid: status.pid,
    startedAt: status.startedAt,
    exitCode: status.exitCode,
    lastError: status.error,
    rconStatus,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}
```

- [ ] **Step 4: 实现路由并接入 app.ts**

`apps/server/src/routes/instances.ts`：

```ts
import fs from 'node:fs';
import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  consoleCommandSchema,
  createInstanceSchema,
  deleteInstanceSchema,
  logsQuerySchema,
  markStoppedSchema,
  probeSchema,
  updateInstanceSchema,
} from '@mcpanel/shared';
import type { AppConfig } from '../config';
import type { DB } from '../db/client';
import { createGuards } from '../auth/guard';
import type { SessionService } from '../auth/session';
import type { LocalNodeDriver } from '../nodes/local-driver';
import type { AuditService } from '../services/audit-service';
import type { InstanceService } from '../services/instance-service';
import { toInstanceInfo } from '../services/instance-serializer';
import type { InstanceSupervisor } from '../services/instance-supervisor';
import type { ProbeService } from '../services/probe-service';
import type { RconService } from '../services/rcon-service';
import { AppError } from '../utils/errors';

export interface InstanceRouteDeps {
  config: AppConfig;
  db: DB;
  sessions: SessionService;
  audit: AuditService;
  instances: InstanceService;
  supervisor: InstanceSupervisor;
  rcon: RconService;
  driver: LocalNodeDriver;
  probe: ProbeService;
}

export function registerInstanceRoutes(app: FastifyInstance, deps: InstanceRouteDeps): void {
  const { audit, instances, supervisor, rcon, driver, probe } = deps;
  const { requireAuth, requireOrigin } = createGuards(app, deps.sessions);
  const read = [requireAuth];
  const write = [requireOrigin, requireAuth, app.csrfProtection];

  const detail = (instanceId: string) => {
    const row = instances.get(instanceId);
    return toInstanceInfo(row, supervisor.getStatus(instanceId), rcon.getCachedStatus(instanceId));
  };

  app.get('/api/instances', { preHandler: read }, async () => ({
    items: instances.list().map((row) => toInstanceInfo(row, supervisor.getStatus(row.id), rcon.getCachedStatus(row.id))),
  }));

  app.post('/api/instances/probe', { preHandler: write }, async (request) => {
    const input = probeSchema.parse(request.body);
    return probe.probe(input.rootPath, instances.list().map((row) => row.rootPath));
  });

  app.post('/api/instances', { preHandler: write }, async (request, reply) => {
    const input = createInstanceSchema.parse(request.body);
    const root = await driver.validateRoot(input.rootPath, instances.list().map((row) => row.rootPath));
    const row = instances.create(input, root);
    audit.record({
      userId: request.user?.id,
      action: 'instance.create',
      targetType: 'instance',
      targetId: row.id,
      detail: { name: row.name, rootPath: row.rootPath },
      ip: request.ip,
    });
    return reply.status(201).send(detail(row.id));
  });

  app.get<{ Params: { id: string } }>('/api/instances/:id', { preHandler: read }, async (request) => detail(request.params.id));

  app.patch<{ Params: { id: string } }>('/api/instances/:id', { preHandler: write }, async (request) => {
    const patch = updateInstanceSchema.parse(request.body);
    const before = instances.get(request.params.id);
    const row = instances.update(request.params.id, patch);
    if (patch.rconHost !== undefined && patch.rconHost !== before.rconHost) rcon.invalidate(row.id);
    audit.record({
      userId: request.user?.id,
      action: 'instance.update',
      targetType: 'instance',
      targetId: row.id,
      detail: { fields: Object.keys(patch) },
      ip: request.ip,
    });
    return detail(row.id);
  });

  app.delete<{ Params: { id: string } }>('/api/instances/:id', { preHandler: write }, async (request, reply) => {
    const input = deleteInstanceSchema.parse(request.body);
    const row = instances.get(request.params.id);
    instances.delete(row, input.confirmName);
    audit.record({
      userId: request.user?.id,
      action: 'instance.delete',
      targetType: 'instance',
      targetId: row.id,
      detail: { name: row.name },
      ip: request.ip,
    });
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/instances/:id/status', { preHandler: read }, async (request) =>
    supervisor.getStatus(request.params.id),
  );

  for (const action of ['start', 'stop', 'restart', 'kill'] as const) {
    app.post<{ Params: { id: string } }>(`/api/instances/:id/actions/${action}`, { preHandler: write }, async (request, reply) => {
      const { id } = request.params;
      instances.get(id);
      switch (action) {
        case 'start':
          await supervisor.start(id);
          break;
        case 'stop':
          await supervisor.stop(id);
          break;
        case 'restart':
          await supervisor.restart(id);
          break;
        case 'kill':
          await supervisor.kill(id);
          break;
      }
      return reply.status(202).send({ state: supervisor.getStatus(id).state });
    });
  }

  app.post<{ Params: { id: string } }>('/api/instances/:id/actions/mark-stopped', { preHandler: write }, async (request, reply) => {
    markStoppedSchema.parse(request.body);
    instances.get(request.params.id);
    await supervisor.markStopped(request.params.id);
    return reply.status(202).send({ state: supervisor.getStatus(request.params.id).state });
  });

  app.get<{ Params: { id: string }; Querystring: { lines?: string } }>(
    '/api/instances/:id/logs',
    { preHandler: read },
    async (request) => {
      const { lines } = logsQuerySchema.parse(request.query);
      return { lines: await supervisor.getRecentLines(request.params.id, lines) };
    },
  );

  app.get<{ Params: { id: string } }>('/api/instances/:id/logs/download', { preHandler: read }, async (request, reply) => {
    const file = supervisor.getLogFilePath(request.params.id);
    if (!fs.existsSync(file)) throw new AppError('NOT_FOUND', '日志文件不存在');
    reply.type('text/plain; charset=utf-8').header('Content-Disposition', 'attachment; filename="latest.log"');
    return reply.send(createReadStream(file));
  });

  app.post<{ Params: { id: string } }>(
    '/api/instances/:id/console/command',
    { preHandler: write },
    async (request) => {
      const input = consoleCommandSchema.parse(request.body);
      instances.get(request.params.id);
      await supervisor.sendCommand(request.params.id, input.command);
      audit.record({
        userId: request.user?.id,
        action: 'console.command',
        targetType: 'instance',
        targetId: request.params.id,
        detail: { command: input.command },
        ip: request.ip,
      });
      return { ok: true };
    },
  );
}
```

`apps/server/src/routes/audit.ts`：

```ts
import type { FastifyInstance } from 'fastify';
import { auditQuerySchema } from '@mcpanel/shared';
import { createGuards } from '../auth/guard';
import type { SessionService } from '../auth/session';
import type { AuditService } from '../services/audit-service';

export function registerAuditRoutes(app: FastifyInstance, deps: { sessions: SessionService; audit: AuditService }): void {
  const { requireAuth } = createGuards(app, deps.sessions);
  app.get('/api/audit', { preHandler: [requireAuth] }, async (request) => {
    const query = auditQuerySchema.parse(request.query);
    return deps.audit.list(query);
  });
}
```

修改 `apps/server/src/app.ts`：

```ts
import { registerInstanceRoutes } from './routes/instances';
import { registerAuditRoutes } from './routes/audit';
import type { InstanceService } from './services/instance-service';
import type { InstanceSupervisor } from './services/instance-supervisor';
import type { RconService } from './services/rcon-service';
import type { LocalNodeDriver } from './nodes/local-driver';
import type { ProbeService } from './services/probe-service';

export interface AppServices {
  sessions: SessionService;
  audit: AuditService;
  loginThrottle: LoginThrottle;
  instances?: InstanceService;
  supervisor?: InstanceSupervisor;
  rcon?: RconService;
  driver?: LocalNodeDriver;
  probe?: ProbeService;
}
```

在 `buildApp` 末尾追加：

```ts
  if (services.instances && services.supervisor && services.rcon && services.driver && services.probe) {
    registerInstanceRoutes(app, {
      config,
      db,
      sessions: services.sessions,
      audit: services.audit,
      instances: services.instances,
      supervisor: services.supervisor,
      rcon: services.rcon,
      driver: services.driver,
      probe: services.probe,
    });
  }
  registerAuditRoutes(app, { sessions: services.sessions, audit: services.audit });
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -w @mcpanel/server -- test/integration/instances-api.test.ts test/integration/auth-routes.test.ts`
Expected: 5 个测试 PASS（instances 2、auth 3）。DELETE 请求带 body 时 Fastify 需要 `payload` 与 `Content-Type: application/json`；`app.inject` 会自动设置。若缺 CSRF 头导致 403，复用同一 CSRF token 即可。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/services/instance-service.ts apps/server/src/services/instance-serializer.ts apps/server/src/routes/instances.ts apps/server/src/routes/audit.ts apps/server/src/app.ts apps/server/test/integration/instances-api.test.ts apps/server/test/helpers/http.ts
git commit -m "feat(server): add instance CRUD, actions, console and audit APIs"
```

---

## Task 12: 指标服务、系统 API 与 WebSocket Hub

**Files:**
- Create: `apps/server/src/utils/disk.ts`, `apps/server/src/services/metrics-service.ts`, `apps/server/src/routes/system.ts`, `apps/server/src/ws/hub.ts`
- Modify: `apps/server/src/app.ts`, `packages/shared/src/types.ts`（补 `pong` 消息）
- Test: `apps/server/test/unit/metrics.test.ts`, `apps/server/test/integration/ws.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/server/test/unit/metrics.test.ts`：

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricsService, type MetricsCollector } from '../../src/services/metrics-service';
import type { InstanceSupervisor } from '../../src/services/instance-supervisor';
import { createTestDb, type TestDb } from '../helpers/db';
import { insertInstanceRow } from '../helpers/factory';

let ctx: TestDb;
let root: string;

afterEach(async () => {
  vi.useRealTimers();
  ctx?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe('MetricsService', () => {
  it('emits system and instance samples while subscribed and stops when inactive', async () => {
    vi.useFakeTimers();
    ctx = createTestDb();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-metrics-'));
    const instance = insertInstanceRow(ctx.db, { name: 'metrics', rootPath: root });
    const collector: MetricsCollector = {
      system: async () => ({
        ts: new Date().toISOString(),
        cpuPercent: 10,
        memUsedBytes: 100,
        memTotalBytes: 200,
        diskFreeBytes: 300,
        diskTotalBytes: 400,
        uptimeSec: 50,
        platform: 'win32',
        arch: 'x64',
        nodeVersion: 'v24.0.0',
        panelVersion: '0.1.0',
      }),
      instance: async () => ({ ts: new Date().toISOString(), cpu: 5, memBytes: 1000, diskFreeBytes: 300 }),
    };
    const supervisor = {
      getStatus: () => ({ instanceId: instance.id, state: 'running', pid: 123, startedAt: null, exitCode: null, error: null }),
    } as unknown as InstanceSupervisor;
    const service = new MetricsService({ collector, supervisor, db: ctx.db, dataDir: ctx.dir });
    const messages: { type: string; target?: string }[] = [];
    service.setSink((message) => messages.push(message as { type: string; target?: string }));

    service.setSystemActive(true);
    service.setInstanceActive(instance.id, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(messages.some((message) => message.target === 'system')).toBe(true);
    expect(messages.some((message) => message.target === 'instance')).toBe(true);

    service.setSystemActive(false);
    service.setInstanceActive(instance.id, false);
    const count = messages.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(messages.length).toBe(count);
    service.stop();
  });

  it('returns a system overview', async () => {
    ctx = createTestDb();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-metrics-'));
    const service = new MetricsService({
      collector: {
        system: async () => ({
          ts: new Date().toISOString(),
          cpuPercent: 1,
          memUsedBytes: 2,
          memTotalBytes: 3,
          diskFreeBytes: 4,
          diskTotalBytes: 5,
          uptimeSec: 6,
          platform: 'linux',
          arch: 'x64',
          nodeVersion: 'v24.0.0',
          panelVersion: '0.1.0',
        }),
        instance: async () => ({ ts: new Date().toISOString(), cpu: 0, memBytes: 0, diskFreeBytes: 0 }),
      },
      supervisor: {} as InstanceSupervisor,
      db: ctx.db,
      dataDir: ctx.dir,
    });
    expect((await service.getSystemOverview()).cpuPercent).toBe(1);
  });
});
```

`apps/server/test/integration/ws.test.ts`：

```ts
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../../src/app';
import { LoginThrottle } from '../../src/auth/guard';
import { SessionService } from '../../src/auth/session';
import { loadConfig } from '../../src/config';
import { silentLogger } from '../../src/logger';
import { LocalNodeDriver } from '../../src/nodes/local-driver';
import { PathSandbox } from '../../src/nodes/path-sandbox';
import { AuditService } from '../../src/services/audit-service';
import { InstanceService } from '../../src/services/instance-service';
import { insertInstanceRow, insertUser } from '../helpers/factory';
import { ProbeService } from '../../src/services/probe-service';
import { RconService } from '../../src/services/rcon-service';
import type { InstanceSupervisor } from '../../src/services/instance-supervisor';
import type { MetricsService } from '../../src/services/metrics-service';
import { createTestDb, type TestDb } from '../helpers/db';

let ctx: TestDb;
let app: Awaited<ReturnType<typeof buildApp>>;
let socket: WebSocket | null = null;

afterEach(async () => {
  socket?.close();
  socket = null;
  await app?.close();
  ctx?.close();
});

function nextMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => ws.once('message', (data) => resolve(JSON.parse(data.toString()))));
}

describe('WebSocket hub', () => {
  it('authenticates, sends snapshots and publishes console/state', async () => {
    ctx = createTestDb();
    const instance = insertInstanceRow(ctx.db, { name: 'ws' });
    const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: ctx.dir });
    const sessions = new SessionService(ctx.db);
    const userId = insertUser(ctx.db);
    const { token } = sessions.create(userId, null, null);
    const supervisor = Object.assign(new EventEmitter(), {
      getStatus: () => ({ instanceId: instance.id, state: 'stopped', pid: null, startedAt: null, exitCode: null, error: null }),
      getConsoleSnapshot: async () => ({ mode: 'snapshot', lines: [], gap: false }),
    });
    const metrics = {
      setSink: () => undefined,
      setSystemActive: () => undefined,
      setInstanceActive: () => undefined,
      getLatestSystem: () => null,
      getLatestInstance: () => null,
      getSystemOverview: async () => ({}),
      stop: () => undefined,
    } as unknown as MetricsService;

    app = await buildApp(
      config,
      ctx.db,
      {
        sessions,
        audit: new AuditService(ctx.db),
        loginThrottle: new LoginThrottle(),
        instances: new InstanceService(ctx.db, ctx.dir),
        supervisor: supervisor as unknown as InstanceSupervisor,
        rcon: new RconService(),
        driver: new LocalNodeDriver(new PathSandbox(ctx.dir)),
        probe: new ProbeService(new PathSandbox(ctx.dir), async () => null),
        metrics,
      },
      { logger: silentLogger() },
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/ws`, {
      headers: { cookie: `mcpanel_session=${token}`, origin: `http://127.0.0.1:${address.port}` },
    });
    const hello = await nextMessage(socket);
    expect(hello.type).toBe('hello');

    socket.send(JSON.stringify({ type: 'subscribe', channel: `instance:${instance.id}:console` }));
    const snapshot = await nextMessage(socket);
    expect(snapshot).toMatchObject({ type: 'console.snapshot', channel: `instance:${instance.id}:console` });

    socket.send(JSON.stringify({ type: 'subscribe', channel: `instance:${instance.id}:status` }));
    const state = await nextMessage(socket);
    expect(state.type).toBe('instance.state');

    supervisor.emit('console', instance.id, [
      { seq: 1, ts: new Date().toISOString(), stream: 'stdout', level: 'info', text: 'hello' },
    ]);
    const append = await nextMessage(socket);
    expect(append).toMatchObject({ type: 'console.append' });
  });
});
```

> 该测试里的 `supervisor` 是 `Object.assign(new EventEmitter(), {...})`，因此既能提供 `getStatus`/`getConsoleSnapshot`，又能通过 `emit` 推送控制台消息。不要改回普通对象。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/server -- test/unit/metrics.test.ts test/integration/ws.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 更新 shared 类型**

在 `packages/shared/src/types.ts` 的 `ServerWsMessage` 联合类型中追加：

```ts
  | { type: 'pong' }
```

- [ ] **Step 4: 实现磁盘、指标与系统路由**

`apps/server/src/utils/disk.ts`：

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import si from 'systeminformation';

export async function diskUsage(target: string): Promise<{ free: number; total: number }> {
  try {
    const stat = await fs.statfs(target);
    return { free: stat.bavail * stat.bsize, total: stat.blocks * stat.bsize };
  } catch {
    const resolved = path.resolve(target).toLowerCase();
    const filesystems = await si.fsSize();
    const match = filesystems.find((entry) => resolved.startsWith(path.resolve(entry.mount).toLowerCase()));
    const selected = match ?? filesystems[0];
    return selected ? { free: selected.available, total: selected.size } : { free: 0, total: 0 };
  }
}
```

`apps/server/src/services/metrics-service.ts`：

```ts
import pidusage from 'pidusage';
import si from 'systeminformation';
import { eq } from 'drizzle-orm';
import { PANEL_VERSION, type ProcessMetricsSample, type ServerWsMessage, type SystemMetricsSample } from '@mcpanel/shared';
import type { DB } from '../db/client';
import { instances } from '../db/schema';
import type { InstanceSupervisor } from './instance-supervisor';
import { diskUsage } from '../utils/disk';

export interface MetricsCollector {
  system(dataDir: string): Promise<SystemMetricsSample>;
  instance(pid: number, rootPath: string): Promise<ProcessMetricsSample>;
}

export const defaultCollector: MetricsCollector = {
  async system(dataDir) {
    const [load, mem, disk, time] = await Promise.all([si.currentLoad(), si.mem(), diskUsage(dataDir), si.time()]);
    return {
      ts: new Date().toISOString(),
      cpuPercent: Number(load.currentLoad.toFixed(1)),
      memUsedBytes: mem.used,
      memTotalBytes: mem.total,
      diskFreeBytes: disk.free,
      diskTotalBytes: disk.total,
      uptimeSec: time.uptime,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      panelVersion: PANEL_VERSION,
    };
  },
  async instance(pid, rootPath) {
    const [usage, disk] = await Promise.all([pidusage(pid), diskUsage(rootPath)]);
    return {
      ts: new Date().toISOString(),
      cpu: Number(usage.cpu.toFixed(1)),
      memBytes: usage.memory,
      diskFreeBytes: disk.free,
    };
  },
};

export interface MetricsDeps {
  collector?: MetricsCollector;
  supervisor: InstanceSupervisor;
  db: DB;
  dataDir: string;
}

export class MetricsService {
  private readonly collector: MetricsCollector;
  private readonly systemHistory: SystemMetricsSample[] = [];
  private readonly instanceHistory = new Map<string, ProcessMetricsSample[]>();
  private readonly instanceCounts = new Map<string, number>();
  private systemCount = 0;
  private timer: NodeJS.Timeout | null = null;
  private sampling = false;
  private sink: ((message: ServerWsMessage) => void) | null = null;

  constructor(private readonly deps: MetricsDeps) {
    this.collector = deps.collector ?? defaultCollector;
  }

  setSink(sink: (message: ServerWsMessage) => void): void {
    this.sink = sink;
  }

  setSystemActive(active: boolean): void {
    this.systemCount = Math.max(0, this.systemCount + (active ? 1 : -1));
    this.syncTimer();
  }

  setInstanceActive(instanceId: string, active: boolean): void {
    const next = Math.max(0, (this.instanceCounts.get(instanceId) ?? 0) + (active ? 1 : -1));
    if (next === 0) this.instanceCounts.delete(instanceId);
    else this.instanceCounts.set(instanceId, next);
    this.syncTimer();
  }

  getLatestSystem(): SystemMetricsSample | null {
    return this.systemHistory.at(-1) ?? null;
  }

  getLatestInstance(instanceId: string): ProcessMetricsSample | null {
    return this.instanceHistory.get(instanceId)?.at(-1) ?? null;
  }

  async getSystemOverview(): Promise<SystemMetricsSample> {
    const sample = await this.collector.system(this.deps.dataDir);
    this.pushSystem(sample);
    return sample;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private syncTimer(): void {
    const active = this.systemCount > 0 || this.instanceCounts.size > 0;
    if (active && !this.timer) {
      this.timer = setInterval(() => void this.sample(), 3000);
      this.timer.unref();
      void this.sample();
    } else if (!active && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async sample(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      if (this.systemCount > 0) this.pushSystem(await this.collector.system(this.deps.dataDir));
      for (const instanceId of this.instanceCounts.keys()) {
        const status = this.deps.supervisor.getStatus(instanceId);
        if (!status.pid || !['running', 'orphaned'].includes(status.state)) continue;
        const row = this.deps.db.select().from(instances).where(eq(instances.id, instanceId)).get();
        if (!row) continue;
        const sample = await this.collector.instance(status.pid, row.rootPath).catch(() => null);
        if (!sample) continue;
        const history = this.instanceHistory.get(instanceId) ?? [];
        history.push(sample);
        this.instanceHistory.set(instanceId, history.slice(-60));
        this.sink?.({ type: 'metrics.sample', target: 'instance', instanceId, ts: sample.ts, sample });
      }
    } finally {
      this.sampling = false;
    }
  }

  private pushSystem(sample: SystemMetricsSample): void {
    this.systemHistory.push(sample);
    if (this.systemHistory.length > 60) this.systemHistory.shift();
    this.sink?.({ type: 'metrics.sample', target: 'system', ts: sample.ts, sample });
  }
}
```

`apps/server/src/routes/system.ts`：

```ts
import type { FastifyInstance } from 'fastify';
import { createGuards } from '../auth/guard';
import type { SessionService } from '../auth/session';
import type { MetricsService } from '../services/metrics-service';

export function registerSystemRoutes(app: FastifyInstance, deps: { sessions: SessionService; metrics: MetricsService }): void {
  const { requireAuth } = createGuards(app, deps.sessions);
  app.get('/api/system/overview', { preHandler: [requireAuth] }, async () => deps.metrics.getSystemOverview());
}
```

- [ ] **Step 5: 实现 WebSocket Hub**

`apps/server/src/ws/hub.ts`：

```ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { WebSocket } from 'ws';
import { SESSION_COOKIE, WS_CHANNEL_PATTERN, wsClientMessageSchema, type ConsoleLine, type ServerWsMessage } from '@mcpanel/shared';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { DB } from '../db/client';
import { instances } from '../db/schema';
import type { SessionService } from '../auth/session';
import type { InstanceSupervisor } from '../services/instance-supervisor';
import type { MetricsService } from '../services/metrics-service';
import { AppError } from '../utils/errors';

const MAX_BUFFERED = 1024 * 1024;
const IDLE_TIMEOUT_MS = 70_000;

interface ClientConn {
  socket: WebSocket;
  subscriptions: Set<string>;
  lastSeen: number;
  dropped: Map<string, number>;
  heartbeat: NodeJS.Timeout;
}

export interface WsHubDeps {
  db: DB;
  sessions: SessionService;
  supervisor: InstanceSupervisor;
  metrics: MetricsService;
  logger: Logger;
}

export class WsHub {
  private readonly clients = new Map<WebSocket, ClientConn>();

  constructor(private readonly deps: WsHubDeps) {
    deps.supervisor.on('console', (instanceId: string, lines: ConsoleLine[]) => this.publishConsole(instanceId, lines));
    deps.supervisor.on('state', (snapshot: { instanceId: string }) => this.publishState(snapshot));
    deps.metrics.setSink((message) => this.publishMetrics(message));
  }

  register(app: FastifyInstance): void {
    app.get(
      '/api/ws',
      {
        websocket: true,
        preValidation: [
          async (request: FastifyRequest) => {
            const origin = request.headers.origin;
            if (!origin) throw new AppError('FORBIDDEN', '缺少来源信息');
            let host: string;
            try {
              host = new URL(origin).host;
            } catch {
              throw new AppError('FORBIDDEN', '来源校验失败');
            }
            if (host !== request.headers.host) throw new AppError('FORBIDDEN', '来源校验失败');
            const token = request.cookies[SESSION_COOKIE];
            const resolved = token ? deps.sessions.resolve(token) : null;
            if (!resolved) throw new AppError('AUTH_REQUIRED', '请先登录');
            request.user = resolved.user;
            request.sessionToken = token ?? null;
          },
        ],
      },
      (socket) => this.attach(socket),
    );
  }

  publishConsole(instanceId: string, lines: ConsoleLine[]): void {
    const channel = `instance:${instanceId}:console`;
    for (const conn of this.clients.values()) {
      if (!conn.subscriptions.has(channel)) continue;
      if (conn.socket.bufferedAmount > MAX_BUFFERED) {
        conn.dropped.set(channel, (conn.dropped.get(channel) ?? 0) + lines.length);
        continue;
      }
      const dropped = conn.dropped.get(channel) ?? 0;
      if (dropped > 0) {
        this.send(conn, { type: 'console.gap', channel, dropped });
        conn.dropped.delete(channel);
      }
      this.send(conn, { type: 'console.append', channel, lines });
    }
  }

  publishState(snapshot: { instanceId: string; state: string; pid: number | null; startedAt: string | null; error: string | null }): void {
    const channel = `instance:${snapshot.instanceId}:status`;
    for (const conn of this.clients.values()) {
      if (conn.subscriptions.has(channel)) {
        this.send(conn, {
          type: 'instance.state',
          instanceId: snapshot.instanceId,
          state: snapshot.state as never,
          pid: snapshot.pid,
          startedAt: snapshot.startedAt,
          error: snapshot.error,
        });
      }
    }
  }

  publishMetrics(message: ServerWsMessage): void {
    if (message.type !== 'metrics.sample') return;
    const channel = message.target === 'system' ? 'system:metrics' : `instance:${message.instanceId}:metrics`;
    for (const conn of this.clients.values()) {
      if (conn.subscriptions.has(channel)) this.send(conn, message);
    }
  }

  closeAll(): void {
    for (const conn of this.clients.values()) {
      clearInterval(conn.heartbeat);
      conn.socket.close();
    }
    this.clients.clear();
  }

  private attach(socket: WebSocket): void {
    const conn: ClientConn = {
      socket,
      subscriptions: new Set(),
      lastSeen: Date.now(),
      dropped: new Map(),
      heartbeat: setInterval(() => {
        if (Date.now() - conn.lastSeen > IDLE_TIMEOUT_MS) socket.close(1000, 'idle');
      }, 30_000),
    };
    conn.heartbeat.unref();
    this.clients.set(socket, conn);
    this.send(conn, { type: 'hello', channels: [], serverTime: new Date().toISOString() });

    socket.on('message', (raw) => {
      conn.lastSeen = Date.now();
      void this.handle(conn, raw.toString());
    });
    socket.on('close', () => this.cleanup(conn));
    socket.on('error', () => this.cleanup(conn));
  }

  private async handle(conn: ClientConn, raw: string): Promise<void> {
    let message: ReturnType<typeof wsClientMessageSchema.parse>;
    try {
      message = wsClientMessageSchema.parse(JSON.parse(raw));
    } catch {
      this.send(conn, { type: 'error', code: 'VALIDATION_ERROR', message: '消息格式错误' });
      return;
    }
    if (message.type === 'ping') {
      this.send(conn, { type: 'pong' });
      return;
    }
    if (!WS_CHANNEL_PATTERN.test(message.channel)) {
      this.send(conn, { type: 'error', code: 'FORBIDDEN', message: '未知频道' });
      return;
    }

    if (message.type === 'unsubscribe') {
      if (!conn.subscriptions.delete(message.channel)) return;
      this.releaseChannel(conn, message.channel);
      return;
    }

    if (conn.subscriptions.has(message.channel)) {
      await this.sendInitial(conn, message.channel, message.sinceSeq);
      return;
    }

    const parts = message.channel.split(':');
    if (parts[0] === 'instance') {
      const instanceId = parts[1]!;
      const exists = this.deps.db.select({ id: instances.id }).from(instances).where(eq(instances.id, instanceId)).get();
      if (!exists) {
        this.send(conn, { type: 'error', code: 'NOT_FOUND', message: '实例不存在' });
        return;
      }
      if (parts[2] === 'players') {
        this.send(conn, { type: 'error', code: 'FORBIDDEN', message: '玩家频道将在阶段 2 提供' });
        return;
      }
    }
    if (message.channel.startsWith('task:')) {
      this.send(conn, { type: 'error', code: 'FORBIDDEN', message: '任务频道将在阶段 3 提供' });
      return;
    }

    conn.subscriptions.add(message.channel);
    if (message.channel === 'system:metrics') this.deps.metrics.setSystemActive(true);
    else if (parts[0] === 'instance' && parts[2] === 'metrics') this.deps.metrics.setInstanceActive(parts[1]!, true);
    await this.sendInitial(conn, message.channel, message.sinceSeq);
  }

  private async sendInitial(conn: ClientConn, channel: string, sinceSeq?: number): Promise<void> {
    if (channel === 'system:metrics') {
      const latest = this.deps.metrics.getLatestSystem();
      if (latest) this.send(conn, { type: 'metrics.sample', target: 'system', ts: latest.ts, sample: latest });
      return;
    }
    const [kind, instanceId, sub] = channel.split(':');
    if (kind !== 'instance' || !instanceId) return;
    if (sub === 'console') {
      const snapshot = await this.deps.supervisor.getConsoleSnapshot(instanceId, sinceSeq);
      if (snapshot.mode === 'append') {
        this.send(conn, { type: 'console.append', channel, lines: snapshot.lines });
      } else {
        this.send(conn, {
          type: 'console.snapshot',
          channel,
          lines: snapshot.lines,
          lastSeq: snapshot.lines.at(-1)?.seq ?? 0,
          gap: snapshot.gap,
        });
      }
      return;
    }
    if (sub === 'status') {
      const status = this.deps.supervisor.getStatus(instanceId);
      this.send(conn, {
        type: 'instance.state',
        instanceId,
        state: status.state,
        pid: status.pid,
        startedAt: status.startedAt,
        error: status.error,
      });
      return;
    }
    if (sub === 'metrics') {
      const latest = this.deps.metrics.getLatestInstance(instanceId);
      if (latest) this.send(conn, { type: 'metrics.sample', target: 'instance', instanceId, ts: latest.ts, sample: latest });
    }
  }

  private releaseChannel(conn: ClientConn, channel: string): void {
    if (channel === 'system:metrics') {
      this.deps.metrics.setSystemActive(false);
      return;
    }
    const [kind, instanceId, sub] = channel.split(':');
    if (kind === 'instance' && instanceId && sub === 'metrics') this.deps.metrics.setInstanceActive(instanceId, false);
  }

  private cleanup(conn: ClientConn): void {
    if (!this.clients.has(conn.socket)) return;
    for (const channel of conn.subscriptions) this.releaseChannel(conn, channel);
    conn.subscriptions.clear();
    clearInterval(conn.heartbeat);
    this.clients.delete(conn.socket);
  }

  private send(conn: ClientConn, message: ServerWsMessage): void {
    if (conn.socket.readyState !== WebSocket.OPEN) return;
    conn.socket.send(JSON.stringify(message));
  }
}
```

修改 `apps/server/src/app.ts`：

```ts
import { registerSystemRoutes } from './routes/system';
import type { MetricsService } from './services/metrics-service';
import { WsHub } from './ws/hub';

export interface AppServices {
  // ...existing fields
  metrics?: MetricsService;
}
```

在 `buildApp` 内、注册路由之前（`metrics` 可选，便于 Task 10/11 的测试省略）：

```ts
  let hub: WsHub | null = null;
  if (services.metrics && services.supervisor) {
    hub = new WsHub({
      db,
      sessions: services.sessions,
      supervisor: services.supervisor,
      metrics: services.metrics,
      logger: app.log,
    });
    hub.register(app);
  }
```

在路由注册之后追加：

```ts
  if (services.metrics) {
    registerSystemRoutes(app, { sessions: services.sessions, metrics: services.metrics });
  }
  app.addHook('onClose', async () => {
    hub?.closeAll();
    services.metrics?.stop();
  });
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npm test -w @mcpanel/server -- test/unit/metrics.test.ts test/integration/ws.test.ts`
Expected: metrics 2 个 PASS；ws 1 个 PASS。若 WS 握手 401，检查 Cookie/Origin 是否与监听地址的 Host 一致。

- [ ] **Step 7: 提交**

```bash
git add packages/shared/src/types.ts apps/server/src/utils/disk.ts apps/server/src/services/metrics-service.ts apps/server/src/routes/system.ts apps/server/src/ws/hub.ts apps/server/src/app.ts apps/server/test/unit/metrics.test.ts apps/server/test/integration/ws.test.ts
git commit -m "feat(server): add metrics, system API and websocket hub"
```

---

## Task 13: 前端基础、认证页、应用外壳与仪表盘

**Files:**
- Create: `apps/web/src/styles/index.css`, `apps/web/src/utils/cn.ts`, `apps/web/src/utils/format.ts`, `apps/web/src/api/client.ts`, `apps/web/src/stores/realtime.ts`, `apps/web/src/stores/ui.ts`
- Create: `apps/web/src/components/ui/index.tsx`, `apps/web/src/components/StatusBadge.tsx`, `apps/web/src/components/MetricsSparkline.tsx`
- Create: `apps/web/src/layouts/AppShell.tsx`, `apps/web/src/pages/SetupPage.tsx`, `apps/web/src/pages/LoginPage.tsx`, `apps/web/src/pages/DashboardPage.tsx`
- Create: `apps/web/src/router.tsx`, `apps/web/src/main.tsx`
- Test: `apps/web/test/setup.ts`, `apps/web/test/status-badge.test.tsx`, `apps/web/test/realtime.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/web/test/setup.ts`：

```ts
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => cleanup());
```

`apps/web/test/status-badge.test.tsx`：

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from '../src/components/StatusBadge';

describe('StatusBadge', () => {
  it('renders text for every state, not only color', () => {
    const { rerender } = render(<StatusBadge state="running" />);
    expect(screen.getByText('运行中')).toBeInTheDocument();
    rerender(<StatusBadge state="orphaned" />);
    expect(screen.getByText('未接管')).toBeInTheDocument();
    rerender(<StatusBadge state="unknown" />);
    expect(screen.getByText('状态未知')).toBeInTheDocument();
  });
});
```

`apps/web/test/realtime.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { ServerWsMessage } from '@mcpanel/shared';
import { emptyRealtime, reduceRealtime } from '../src/stores/realtime';

const channel = 'instance:11111111-1111-4111-8111-111111111111:console';

describe('realtime reducer', () => {
  it('stores snapshots and deduplicates appended console lines', () => {
    const snapshot: ServerWsMessage = {
      type: 'console.snapshot',
      channel,
      lines: [{ seq: 1, ts: '2026-10-23T00:00:00.000Z', stream: 'stdout', level: 'info', text: 'one' }],
      lastSeq: 1,
      gap: false,
    };
    let state = reduceRealtime(emptyRealtime, snapshot);
    state = reduceRealtime(state, {
      type: 'console.append',
      channel,
      lines: [
        { seq: 2, ts: '2026-10-23T00:00:01.000Z', stream: 'stdout', level: 'info', text: 'two' },
        { seq: 2, ts: '2026-10-23T00:00:01.000Z', stream: 'stdout', level: 'info', text: 'two' },
      ],
    });
    const consoleState = state.console['11111111-1111-4111-8111-111111111111'];
    expect(consoleState?.lines.map((line) => line.text)).toEqual(['one', 'two']);
    expect(consoleState?.lastSeq).toBe(2);
  });

  it('keeps at most 5000 lines and marks gaps', () => {
    const lines = Array.from({ length: 5001 }, (_, index) => ({
      seq: index + 1,
      ts: '2026-10-23T00:00:00.000Z',
      stream: 'stdout' as const,
      level: 'info' as const,
      text: String(index),
    }));
    let state = reduceRealtime(emptyRealtime, { type: 'console.snapshot', channel, lines, lastSeq: 5001, gap: false });
    expect(state.console['11111111-1111-4111-8111-111111111111']?.lines).toHaveLength(5000);
    state = reduceRealtime(state, { type: 'console.gap', channel, dropped: 5 });
    expect(state.console['11111111-1111-4111-8111-111111111111']?.gap).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/web`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现样式、API 客户端与实时 store**

`apps/web/src/styles/index.css`：

```css
@import "tailwindcss";
@custom-variant dark (&:where(.dark, .dark *));

:root {
  --bg: #f5f7f4;
  --surface: #ffffff;
  --surface-2: #edf1ec;
  --border: #d9dfd7;
  --fg: #172018;
  --muted: #677468;
  --primary: #15803d;
  --primary-soft: #dcfce7;
  --danger: #dc2626;
  --warn: #b45309;
}

.dark {
  --bg: #0b0f0d;
  --surface: #111713;
  --surface-2: #18211b;
  --border: #27322b;
  --fg: #e8f0ea;
  --muted: #94a498;
  --primary: #4ade80;
  --primary-soft: #14351f;
  --danger: #f87171;
  --warn: #fbbf24;
}

html, body, #root { height: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, sans-serif;
  font-size: 14px;
}
* { box-sizing: border-box; }
button, input, select, textarea { font: inherit; }
.console-font { font-family: ui-monospace, Consolas, "Courier New", monospace; }
::selection { background: var(--primary-soft); }
```

`apps/web/src/utils/cn.ts`：

```ts
export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}
```

`apps/web/src/api/client.ts`：

```ts
import type { ApiErrorBody } from '@mcpanel/shared';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let csrfToken: string | null = null;

async function refreshCsrf(): Promise<string> {
  const response = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
  if (!response.ok) throw new ApiError('INTERNAL', '无法获取 CSRF token', response.status);
  csrfToken = ((await response.json()) as { token: string }).token;
  return csrfToken;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  retryCsrf?: boolean;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(method)) headers['X-CSRF-Token'] = csrfToken ?? (await refreshCsrf());

  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as ApiErrorBody | null;
    if (response.status === 403 && data?.error.code === 'CSRF_INVALID' && options.retryCsrf !== false) {
      csrfToken = null;
      return apiRequest<T>(path, { ...options, retryCsrf: false });
    }
    if (response.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new Event('mcpanel:unauthorized'));
    }
    throw new ApiError(
      data?.error.code ?? 'INTERNAL',
      data?.error.message ?? `请求失败（HTTP ${response.status}）`,
      response.status,
      data?.error.details,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => apiRequest<T>(path, { signal }),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  del: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'DELETE', body }),
};
```

`apps/web/src/stores/realtime.ts`：

```ts
import { create } from 'zustand';
import { useEffect } from 'react';
import type {
  ConsoleLine,
  InstanceStatusSnapshot,
  ProcessMetricsSample,
  ServerWsMessage,
  SystemMetricsSample,
} from '@mcpanel/shared';

const MAX_LINES = 5000;
const MAX_SAMPLES = 60;
const EMPTY_CONSOLE: ConsoleState = { lines: [], lastSeq: 0, gap: false };
const EMPTY_METRICS: ProcessMetricsSample[] = [];

export interface ConsoleState {
  lines: ConsoleLine[];
  lastSeq: number;
  gap: boolean;
}

export interface RealtimeState {
  connection: 'closed' | 'connecting' | 'open';
  console: Record<string, ConsoleState>;
  states: Record<string, InstanceStatusSnapshot>;
  systemMetrics: SystemMetricsSample[];
  instanceMetrics: Record<string, ProcessMetricsSample[]>;
}

export const emptyRealtime: RealtimeState = {
  connection: 'closed',
  console: {},
  states: {},
  systemMetrics: [],
  instanceMetrics: {},
};

export function reduceRealtime(state: RealtimeState, message: ServerWsMessage): RealtimeState {
  if (message.type === 'console.snapshot' || message.type === 'console.append') {
    const instanceId = message.channel.split(':')[1];
    if (!instanceId) return state;
    const previous = state.console[instanceId] ?? { lines: [], lastSeq: 0, gap: false };
    let lines: ConsoleLine[];
    if (message.type === 'console.snapshot') {
      lines = message.lines;
    } else {
      const seen = new Set(previous.lines.map((line) => line.seq));
      lines = [...previous.lines, ...message.lines.filter((line) => !seen.has(line.seq))];
    }
    const lastSeq = Math.max(previous.lastSeq, ...lines.map((line) => line.seq), 0);
    return {
      ...state,
      console: {
        ...state.console,
        [instanceId]: {
          lines: lines.slice(-MAX_LINES),
          lastSeq,
          gap: message.type === 'console.snapshot' ? message.gap : previous.gap,
        },
      },
    };
  }
  if (message.type === 'console.gap') {
    const instanceId = message.channel.split(':')[1];
    if (!instanceId) return state;
    const previous = state.console[instanceId] ?? { lines: [], lastSeq: 0, gap: false };
    return { ...state, console: { ...state.console, [instanceId]: { ...previous, gap: true } } };
  }
  if (message.type === 'instance.state') {
    return {
      ...state,
      states: {
        ...state.states,
        [message.instanceId]: {
          instanceId: message.instanceId,
          state: message.state,
          pid: message.pid,
          startedAt: message.startedAt,
          exitCode: null,
          error: message.error,
        },
      },
    };
  }
  if (message.type === 'metrics.sample' && message.target === 'system') {
    return { ...state, systemMetrics: [...state.systemMetrics, message.sample].slice(-MAX_SAMPLES) };
  }
  if (message.type === 'metrics.sample' && message.target === 'instance') {
    return {
      ...state,
      instanceMetrics: {
        ...state.instanceMetrics,
        [message.instanceId]: [...(state.instanceMetrics[message.instanceId] ?? []), message.sample].slice(-MAX_SAMPLES),
      },
    };
  }
  return state;
}

interface RealtimeStore extends RealtimeState {
  apply: (message: ServerWsMessage) => void;
  setConnection: (connection: RealtimeState['connection']) => void;
}

export const useRealtime = create<RealtimeStore>((set) => ({
  ...emptyRealtime,
  apply: (message) => set((state) => reduceRealtime(state, message)),
  setConnection: (connection) => set({ connection }),
}));

const references = new Map<string, number>();
let socket: WebSocket | null = null;
let pingTimer: number | null = null;
let reconnectTimer: number | null = null;
let attempts = 0;
let intentionalClose = false;

function lastSeqFor(channel: string): number | undefined {
  if (!channel.endsWith(':console')) return undefined;
  const instanceId = channel.split(':')[1];
  return instanceId ? useRealtime.getState().console[instanceId]?.lastSeq : undefined;
}

function ensureSocket(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  intentionalClose = false;
  useRealtime.getState().setConnection('connecting');
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/api/ws`);
  socket.addEventListener('open', () => {
    attempts = 0;
    useRealtime.getState().setConnection('open');
    for (const channel of references.keys()) {
      socket?.send(JSON.stringify({ type: 'subscribe', channel, sinceSeq: lastSeqFor(channel) }));
    }
    pingTimer = window.setInterval(() => socket?.send(JSON.stringify({ type: 'ping' })), 30_000);
  });
  socket.addEventListener('message', (event) => {
    try {
      useRealtime.getState().apply(JSON.parse(event.data as string) as ServerWsMessage);
    } catch {
      // ignore malformed frames
    }
  });
  socket.addEventListener('close', () => {
    useRealtime.getState().setConnection('closed');
    if (pingTimer) window.clearInterval(pingTimer);
    pingTimer = null;
    socket = null;
    if (!intentionalClose && references.size > 0) scheduleReconnect();
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(30_000, 1000 * 2 ** attempts);
  attempts += 1;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    if (references.size > 0) ensureSocket();
  }, delay);
}

export function subscribeChannel(channel: string): void {
  const next = (references.get(channel) ?? 0) + 1;
  references.set(channel, next);
  if (next === 1) {
    ensureSocket();
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'subscribe', channel, sinceSeq: lastSeqFor(channel) }));
    }
  }
}

export function unsubscribeChannel(channel: string): void {
  const next = Math.max(0, (references.get(channel) ?? 0) - 1);
  if (next === 0) {
    references.delete(channel);
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'unsubscribe', channel }));
  } else {
    references.set(channel, next);
  }
}

export function disconnectRealtime(): void {
  intentionalClose = true;
  references.clear();
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  socket?.close();
  socket = null;
}

export function useInstanceStatus(instanceId: string): InstanceStatusSnapshot | null {
  const status = useRealtime((state) => state.states[instanceId] ?? null);
  useEffect(() => {
    subscribeChannel(`instance:${instanceId}:status`);
    return () => unsubscribeChannel(`instance:${instanceId}:status`);
  }, [instanceId]);
  return status;
}

export function useInstanceConsole(instanceId: string): ConsoleState {
  const state = useRealtime(
    (store) => store.console[instanceId] ?? EMPTY_CONSOLE,
  );
  useEffect(() => {
    subscribeChannel(`instance:${instanceId}:console`);
    return () => unsubscribeChannel(`instance:${instanceId}:console`);
  }, [instanceId]);
  return state;
}

export function useInstanceMetrics(instanceId: string): ProcessMetricsSample[] {
  const samples = useRealtime((state) => state.instanceMetrics[instanceId] ?? EMPTY_METRICS);
  useEffect(() => {
    subscribeChannel(`instance:${instanceId}:metrics`);
    return () => unsubscribeChannel(`instance:${instanceId}:metrics`);
  }, [instanceId]);
  return samples;
}

export function useSystemMetrics(): SystemMetricsSample[] {
  const samples = useRealtime((state) => state.systemMetrics);
  useEffect(() => {
    subscribeChannel('system:metrics');
    return () => unsubscribeChannel('system:metrics');
  }, []);
  return samples;
}
```

`apps/web/src/stores/ui.ts`：

```ts
import { create } from 'zustand';

export type Theme = 'dark' | 'light' | 'system';

const STORAGE_KEY = 'mcpanel_theme';

function storedTheme(): Theme {
  const value = localStorage.getItem(STORAGE_KEY);
  return value === 'light' || value === 'system' || value === 'dark' ? value : 'dark';
}

export function applyTheme(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

interface UiStore {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

export const useUi = create<UiStore>((set) => ({
  theme: storedTheme(),
  setTheme: (theme) => {
    localStorage.setItem(STORAGE_KEY, theme);
    applyTheme(theme);
    set({ theme });
  },
}));

applyTheme(storedTheme());
```

- [ ] **Step 4: 实现 UI 原语、StatusBadge 与 Sparkline**

`apps/web/src/components/ui/index.tsx`：

```tsx
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Loader2, X } from 'lucide-react';
import { create } from 'zustand';
import { cn } from '../../utils/cn';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-[var(--primary)] text-[#07130b] hover:opacity-90',
  secondary: 'border border-[var(--border)] bg-[var(--surface-2)] text-[var(--fg)] hover:border-[var(--primary)]',
  ghost: 'text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)]',
  danger: 'bg-[var(--danger)] text-white hover:opacity-90',
};

export function Button({
  variant = 'primary',
  loading = false,
  className,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean }) {
  return (
    <button
      className={cn(
        'inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]',
        buttonVariants[variant],
        className,
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--fg)] placeholder:text-[var(--muted)] focus:border-[var(--primary)] focus:outline-none',
        className,
      )}
      {...props}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-[var(--muted)]">{hint}</span>}
    </label>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'danger' }) {
  const tones = {
    neutral: 'bg-[var(--surface-2)] text-[var(--muted)]',
    success: 'bg-[var(--primary-soft)] text-[var(--primary)]',
    warning: 'bg-amber-500/15 text-[var(--warn)]',
    danger: 'bg-red-500/15 text-[var(--danger)]',
  };
  return <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', tones[tone])}>{children}</span>;
}

export function Spinner({ label = '加载中' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-[var(--muted)]" role="status">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xl focus:outline-none',
            wide ? 'max-w-2xl' : 'max-w-lg',
          )}
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <DialogPrimitive.Title className="text-lg font-semibold">{title}</DialogPrimitive.Title>
              {description && <DialogPrimitive.Description className="mt-1 text-sm text-[var(--muted)]">{description}</DialogPrimitive.Description>}
            </div>
            <DialogPrimitive.Close className="rounded-md p-1 text-[var(--muted)] hover:bg-[var(--surface-2)]" aria-label="关闭">
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </div>
          {children}
          {footer && <div className="mt-6 flex justify-end gap-2">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--border)] p-10 text-center">
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-[var(--muted)]">{description}</p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return <div role="alert" className="rounded-lg border border-[var(--danger)]/40 bg-red-500/10 px-4 py-3 text-sm text-[var(--danger)]">{message}</div>;
}

export type ToastLevel = 'info' | 'success' | 'error';
interface ToastItem { id: number; message: string; level: ToastLevel }
interface ToastStore {
  items: ToastItem[];
  push: (message: string, level: ToastLevel) => void;
  remove: (id: number) => void;
}
let toastId = 0;

export const useToastStore = create<ToastStore>((set) => ({
  items: [],
  push: (message, level) => {
    const id = ++toastId;
    set((state) => ({ items: [...state.items, { id, message, level }] }));
    window.setTimeout(() => set((state) => ({ items: state.items.filter((item) => item.id !== id) })), 4000);
  },
  remove: (id) => set((state) => ({ items: state.items.filter((item) => item.id !== id) })),
}));

export function toast(message: string, level: ToastLevel = 'info'): void {
  useToastStore.getState().push(message, level);
}

export function Toaster() {
  const items = useToastStore((state) => state.items);
  return (
    <div className="fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2" aria-live="polite">
      {items.map((item) => (
        <div
          key={item.id}
          className={cn(
            'rounded-lg border px-4 py-3 text-sm shadow-lg',
            item.level === 'error'
              ? 'border-[var(--danger)]/40 bg-red-500/15 text-[var(--danger)]'
              : item.level === 'success'
                ? 'border-[var(--primary)]/40 bg-[var(--primary-soft)] text-[var(--primary)]'
                : 'border-[var(--border)] bg-[var(--surface)]',
          )}
        >
          {item.message}
        </div>
      ))}
    </div>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = '确认',
  danger = false,
  loading = false,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>取消</Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
```

`apps/web/src/components/StatusBadge.tsx`：

```tsx
import type { InstanceState } from '@mcpanel/shared';
import { Badge } from './ui';

const LABELS: Record<InstanceState, { text: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  stopped: { text: '已停止', tone: 'neutral' },
  starting: { text: '启动中', tone: 'warning' },
  running: { text: '运行中', tone: 'success' },
  stopping: { text: '停止中', tone: 'warning' },
  crashed: { text: '已崩溃', tone: 'danger' },
  orphaned: { text: '未接管', tone: 'warning' },
  unknown: { text: '状态未知', tone: 'danger' },
};

export function StatusBadge({ state }: { state: InstanceState }) {
  const item = LABELS[state];
  return <Badge tone={item.tone}>{item.text}</Badge>;
}
```

`apps/web/src/components/MetricsSparkline.tsx`：

```tsx
import { Line, LineChart, ResponsiveContainer } from 'recharts';

export function MetricsSparkline({ values, height = 40 }: { values: number[]; height?: number }) {
  const data = values.map((value, index) => ({ index, value }));
  if (data.length < 2) return <div className="h-10 text-xs text-[var(--muted)]">等待采样…</div>;
  return (
    <div style={{ height }} aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <Line type="monotone" dataKey="value" stroke="var(--primary)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 5: 实现 AppShell、认证页、仪表盘、路由与入口**

`apps/web/src/layouts/AppShell.tsx`：

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { LayoutDashboard, LogOut, Menu, Moon, Server, Sun } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { PANEL_VERSION } from '@mcpanel/shared';
import { api } from '../api/client';
import { disconnectRealtime } from '../stores/realtime';
import { useUi } from '../stores/ui';
import { Button, Toaster, toast } from '../components/ui';
import { cn } from '../utils/cn';

const navigation = [
  { to: '/', label: '总览', icon: LayoutDashboard, end: true },
  { to: '/instances', label: '实例', icon: Server, end: false },
];

export function AppShell() {
  const [drawer, setDrawer] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { theme, setTheme } = useUi();

  const logout = async () => {
    setLoggingOut(true);
    try {
      await api.post('/auth/logout');
    } catch {
      // session may already be gone
    }
    disconnectRealtime();
    queryClient.clear();
    navigate('/login', { replace: true });
    setLoggingOut(false);
  };

  const cycleTheme = () => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark');

  const sidebar = (
    <aside className="flex h-full w-60 flex-col border-r border-[var(--border)] bg-[var(--surface)]">
      <div className="flex h-16 items-center gap-3 px-5">
        <div className="grid grid-cols-2 gap-0.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-[2px] bg-[var(--primary)]" />
          <span className="h-2.5 w-2.5 rounded-[2px] bg-[var(--primary)]/50" />
          <span className="h-2.5 w-2.5 rounded-[2px] bg-[var(--primary)]/30" />
          <span className="h-2.5 w-2.5 rounded-[2px] bg-[var(--primary)]/70" />
        </div>
        <span className="text-base font-semibold tracking-wide">MC Panel</span>
      </div>
      <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
        {navigation.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={() => setDrawer(false)}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition',
                isActive ? 'bg-[var(--primary-soft)] text-[var(--primary)]' : 'text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)]',
              )
            }
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="flex flex-col gap-2 border-t border-[var(--border)] p-3 text-xs text-[var(--muted)]">
        <div className="flex items-center justify-between">
          <span>v{PANEL_VERSION}</span>
          <button type="button" onClick={cycleTheme} className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-[var(--surface-2)]" aria-label="切换主题">
            {theme === 'dark' ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
            {theme === 'dark' ? '深色' : theme === 'light' ? '浅色' : '跟随系统'}
          </button>
        </div>
        <Button variant="ghost" className="justify-start" loading={loggingOut} onClick={logout}>
          <LogOut className="h-4 w-4" /> 退出登录
        </Button>
      </div>
    </aside>
  );

  return (
    <div className="flex h-screen overflow-hidden">
      <div className="hidden md:block">{sidebar}</div>
      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button type="button" className="absolute inset-0 bg-black/60" aria-label="关闭菜单" onClick={() => setDrawer(false)} />
          <div className="relative h-full">{sidebar}</div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-[var(--border)] px-4 md:hidden">
          <Button variant="ghost" onClick={() => setDrawer(true)} aria-label="打开菜单"><Menu className="h-5 w-5" /></Button>
          <span className="font-semibold">MC Panel</span>
          <button type="button" onClick={cycleTheme} className="p-2 text-[var(--muted)]" aria-label="切换主题">
            {theme === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
          </button>
        </header>
        <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-8">
          <Outlet />
        </main>
      </div>
      <Toaster />
    </div>
  );
}
```

`apps/web/src/pages/SetupPage.tsx`：

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import type { AuthStatus } from '@mcpanel/shared';
import { api, ApiError } from '../api/client';
import { Button, ErrorState, Field, Input, Spinner } from '../components/ui';

export function SetupPage() {
  const status = useQuery({ queryKey: ['auth', 'status'], queryFn: () => api.get<AuthStatus>('/auth/status') });
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api.post('/auth/setup', { username, password }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['auth'] });
      navigate('/', { replace: true });
    },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : '初始化失败'),
  });

  if (status.isLoading) return <div className="grid min-h-screen place-items-center"><Spinner /></div>;
  if (status.data && !status.data.setupRequired) return <Navigate to="/" replace />;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password.length < 12) return setError('密码至少 12 个字符');
    if (password !== confirm) return setError('两次输入的密码不一致');
    mutation.mutate();
  };

  return (
    <div className="grid min-h-screen place-items-center bg-[var(--bg)] p-4">
      <form onSubmit={submit} className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 shadow-sm">
        <h1 className="text-xl font-semibold">初始化面板</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">创建唯一的本机管理员账号。密码至少 12 个字符。</p>
        <div className="mt-6 flex flex-col gap-4">
          <Field label="用户名"><Input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required /></Field>
          <Field label="密码"><Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required /></Field>
          <Field label="确认密码"><Input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" required /></Field>
          {error && <ErrorState message={error} />}
          <Button type="submit" loading={mutation.isPending}>创建管理员</Button>
        </div>
      </form>
    </div>
  );
}
```

`apps/web/src/pages/LoginPage.tsx`：

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import type { AuthStatus } from '@mcpanel/shared';
import { api, ApiError } from '../api/client';
import { Button, ErrorState, Field, Input, Spinner } from '../components/ui';

export function LoginPage() {
  const status = useQuery({ queryKey: ['auth', 'status'], queryFn: () => api.get<AuthStatus>('/auth/status') });
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api.post('/auth/login', { username, password }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['auth'] });
      navigate(params.get('next') ?? '/', { replace: true });
    },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : '登录失败'),
  });

  if (status.isLoading) return <div className="grid min-h-screen place-items-center"><Spinner /></div>;
  if (status.data?.setupRequired) return <Navigate to="/setup" replace />;
  if (status.data?.authenticated) return <Navigate to="/" replace />;

  return (
    <div className="grid min-h-screen place-items-center bg-[var(--bg)] p-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          mutation.mutate();
        }}
        className="w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 shadow-sm"
      >
        <h1 className="text-xl font-semibold">登录 MC Panel</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">管理本机 Minecraft 服务器</p>
        <div className="mt-6 flex flex-col gap-4">
          <Field label="用户名"><Input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required /></Field>
          <Field label="密码"><Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></Field>
          {error && <ErrorState message={error} />}
          <Button type="submit" loading={mutation.isPending}>登录</Button>
        </div>
      </form>
    </div>
  );
}
```

`apps/web/src/pages/DashboardPage.tsx`：

```tsx
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Cpu, HardDrive, MemoryStick, Server, Timer } from 'lucide-react';
import type { AuditEntry, InstanceInfo, Paginated, SystemMetricsSample } from '@mcpanel/shared';
import { api } from '../api/client';
import { MetricsSparkline } from '../components/MetricsSparkline';
import { StatusBadge } from '../components/StatusBadge';
import { EmptyState, ErrorState, Spinner } from '../components/ui';
import { useInstanceMetrics, useSystemMetrics } from '../stores/realtime';
import { formatBytes, formatDuration } from '../utils/format';

function MetricCard({ icon: Icon, label, value, detail }: { icon: typeof Cpu; label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-center gap-2 text-xs text-[var(--muted)]"><Icon className="h-4 w-4" />{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      {detail && <div className="mt-1 text-xs text-[var(--muted)]">{detail}</div>}
    </div>
  );
}

function InstanceCard({ instance }: { instance: InstanceInfo }) {
  const samples = useInstanceMetrics(instance.id);
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/instances/${instance.id}/overview`} className="truncate font-medium hover:text-[var(--primary)]">{instance.name}</Link>
          <div className="mt-1 text-xs text-[var(--muted)]">{instance.rootPath}</div>
        </div>
        <StatusBadge state={instance.state} />
      </div>
      <div className="mt-3"><MetricsSparkline values={samples.map((sample) => sample.cpu)} /></div>
      <div className="mt-2 flex items-center justify-between text-xs text-[var(--muted)]">
        <span>{samples.at(-1) ? `CPU ${samples.at(-1)!.cpu.toFixed(1)}% · ${formatBytes(samples.at(-1)!.memBytes)}` : '暂无采样'}</span>
        <Link to={`/instances/${instance.id}/console`} className="text-[var(--primary)] hover:underline">控制台</Link>
      </div>
      {instance.lastError && <div className="mt-2 truncate text-xs text-[var(--danger)]">{instance.lastError}</div>}
    </div>
  );
}

export function DashboardPage() {
  const overview = useQuery({
    queryKey: ['system', 'overview'],
    queryFn: () => api.get<SystemMetricsSample>('/system/overview'),
    refetchInterval: 15_000,
  });
  const instances = useQuery({ queryKey: ['instances'], queryFn: () => api.get<{ items: InstanceInfo[] }>('/instances') });
  const audit = useQuery({
    queryKey: ['audit', 'recent'],
    queryFn: () => api.get<Paginated<AuditEntry>>('/audit?page=1&pageSize=10'),
  });
  const liveSystem = useSystemMetrics();
  const latest = liveSystem.at(-1) ?? overview.data;

  const warnings: string[] = [];
  for (const instance of instances.data?.items ?? []) {
    if (instance.state === 'unknown') warnings.push(`${instance.name}：状态未知，请检查进程`);
    if (instance.state === 'orphaned') warnings.push(`${instance.name}：进程未接管，可通过 RCON 停止`);
    if (instance.rconStatus === 'disabled') warnings.push(`${instance.name}：未启用 RCON`);
  }
  if (latest && latest.diskTotalBytes > 0 && latest.diskFreeBytes / latest.diskTotalBytes < 0.1) warnings.push('磁盘剩余空间低于 10%');

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">总览</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">系统状态与服务器概况</p>
      </div>

      {overview.isError && <ErrorState message="系统指标加载失败" />}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={Cpu} label="CPU" value={latest ? `${latest.cpuPercent.toFixed(1)}%` : '—'} />
        <MetricCard icon={MemoryStick} label="内存" value={latest ? formatBytes(latest.memUsedBytes) : '—'} detail={latest ? `共 ${formatBytes(latest.memTotalBytes)}` : undefined} />
        <MetricCard icon={HardDrive} label="数据盘剩余" value={latest ? formatBytes(latest.diskFreeBytes) : '—'} detail={latest ? `共 ${formatBytes(latest.diskTotalBytes)}` : undefined} />
        <MetricCard icon={Timer} label="系统运行" value={latest ? formatDuration(latest.uptimeSec) : '—'} detail={latest ? `Node ${latest.nodeVersion}` : undefined} />
      </div>

      {warnings.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-[var(--warn)]">
          <div className="font-medium">需要注意</div>
          <ul className="mt-2 list-inside list-disc space-y-1">{warnings.slice(0, 5).map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </div>
      )}

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold"><Server className="h-4 w-4" />实例</h2>
          <Link to="/instances" className="text-sm text-[var(--primary)] hover:underline">全部实例 →</Link>
        </div>
        {instances.isLoading ? (
          <Spinner />
        ) : instances.data?.items.length ? (
          <div className="grid gap-3 md:grid-cols-2">{instances.data.items.map((instance) => <InstanceCard key={instance.id} instance={instance} />)}</div>
        ) : (
          <EmptyState
            title="还没有纳管实例"
            description="纳管一个已经安装好的 Fabric / Forge / NeoForge 服务器目录，面板不会移动或覆盖你的文件。"
            action={<Link to="/instances" className="inline-flex h-9 items-center rounded-lg bg-[var(--primary)] px-3 text-sm font-medium text-[#07130b]">纳管第一个实例</Link>}
          />
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">最近活动</h2>
        <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          {audit.data?.items.length ? (
            audit.data.items.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2 text-sm last:border-0">
                <span>{entry.action}</span>
                <span className="text-xs text-[var(--muted)]">{new Date(entry.createdAt).toLocaleString()}</span>
              </div>
            ))
          ) : (
            <div className="px-4 py-6 text-sm text-[var(--muted)]">暂无活动</div>
          )}
        </div>
      </section>
    </div>
  );
}
```

`apps/web/src/utils/format.ts`：

```ts
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分`;
}
```

`apps/web/src/router.tsx`：

```tsx
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { AuthStatus } from '@mcpanel/shared';
import { api } from './api/client';
import { AppShell } from './layouts/AppShell';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { SetupPage } from './pages/SetupPage';
import { Spinner } from './components/ui';

function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation();
  const status = useQuery({ queryKey: ['auth', 'status'], queryFn: () => api.get<AuthStatus>('/auth/status'), retry: false });
  if (status.isLoading) return <div className="grid min-h-screen place-items-center"><Spinner /></div>;
  if (status.data?.setupRequired) return <Navigate to="/setup" replace />;
  if (!status.data?.authenticated) {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  }
  return <>{children}</>;
}

export function AppRouter() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<RequireAuth><AppShell /></RequireAuth>}>
        <Route index element={<DashboardPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppRouter } from './router';
import './styles/index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

window.addEventListener('mcpanel:unauthorized', () => {
  queryClient.clear();
  if (!location.pathname.startsWith('/login') && !location.pathname.startsWith('/setup')) {
    location.assign(`/login?next=${encodeURIComponent(location.pathname)}`);
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppRouter />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 6: 运行测试与类型检查**

Run: `npm test -w @mcpanel/web && npm run typecheck -w @mcpanel/web`
Expected: 2 个测试文件共 3 个测试 PASS；typecheck 无输出。构建尚未包含实例页，后续任务补齐。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src apps/web/test
git commit -m "feat(web): add app shell, auth pages, realtime store and dashboard"
```

---

## Task 14: 实例列表、纳管对话框、实例布局与概览

**Files:**
- Create: `apps/web/src/pages/InstancesPage.tsx`, `apps/web/src/components/CreateInstanceDialog.tsx`, `apps/web/src/layouts/InstanceLayout.tsx`, `apps/web/src/pages/instance/OverviewTab.tsx`
- Modify: `apps/web/src/router.tsx`
- Test: `apps/web/test/create-instance-dialog.test.tsx`

- [ ] **Step 1: 写失败测试**

`apps/web/test/create-instance-dialog.test.tsx`：

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { CreateInstanceDialog } from '../src/components/CreateInstanceDialog';

vi.mock('../src/api/client', () => ({
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {},
}));

afterEach(() => vi.clearAllMocks());

describe('CreateInstanceDialog', () => {
  it('probes a directory and fills the suggested start command', async () => {
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rootPath: 'D:\\servers\\survival',
      valid: true,
      detected: {
        startScripts: ['run.bat'],
        serverJars: ['fabric-server-launch.jar'],
        levelName: 'world',
        serverPort: 25565,
        enableRcon: true,
        rconPort: 25575,
        onlineMode: true,
        hasMods: true,
        hasConfig: true,
        eula: true,
      },
      java: { path: 'java', major: 21 },
      suggestedStartCommand: 'run.bat',
      warnings: [],
    });

    render(
      <MemoryRouter>
        <CreateInstanceDialog open onOpenChange={() => undefined} />
      </MemoryRouter>,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('服务器目录'), 'D:\\servers\\survival');
    await user.click(screen.getByRole('button', { name: '检测目录' }));

    expect(await screen.findByDisplayValue('run.bat')).toBeInTheDocument();
    expect(screen.getByText('Java 21')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/web -- test/create-instance-dialog.test.tsx`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现纳管对话框与实例列表**

`apps/web/src/components/CreateInstanceDialog.tsx`：

```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { InstanceInfo, ProbeResult } from '@mcpanel/shared';
import { api, ApiError } from '../api/client';
import { Button, Dialog, ErrorState, Field, Input, toast } from './ui';

function defaultName(rootPath: string): string {
  const parts = rootPath.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? '新实例';
}

export function CreateInstanceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [rootPath, setRootPath] = useState('');
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [name, setName] = useState('');
  const [startCommand, setStartCommand] = useState('');
  const [javaPath, setJavaPath] = useState('');
  const [stopTimeout, setStopTimeout] = useState(30);
  const [encoding, setEncoding] = useState<'utf-8' | 'gbk'>('utf-8');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const probeMutation = useMutation({
    mutationFn: () => api.post<ProbeResult>('/instances/probe', { rootPath }),
    onSuccess: (result) => {
      setProbe(result);
      setName(name || defaultName(result.rootPath));
      setStartCommand(result.suggestedStartCommand ?? '');
      setError(null);
    },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : '目录检测失败'),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.post<InstanceInfo>('/instances', {
        name,
        rootPath,
        startCommand,
        javaPath: javaPath || null,
        stopTimeoutSec: stopTimeout,
        logEncoding: encoding,
      }),
    onSuccess: async (instance) => {
      await queryClient.invalidateQueries({ queryKey: ['instances'] });
      toast('实例已纳管', 'success');
      reset();
      onOpenChange(false);
      navigate(`/instances/${instance.id}/overview`);
    },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : '创建失败'),
  });

  const reset = () => {
    setRootPath('');
    setProbe(null);
    setName('');
    setStartCommand('');
    setJavaPath('');
    setStopTimeout(30);
    setEncoding('utf-8');
    setError(null);
  };

  const close = () => {
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title="纳管服务器"
      description="选择一个已经安装好的 Java 服务端目录，面板只读取现有文件。"
      wide
      footer={
        <>
          <Button variant="secondary" onClick={close}>取消</Button>
          <Button disabled={!probe} loading={createMutation.isPending} onClick={() => createMutation.mutate()}>创建实例</Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Field label="服务器目录" hint="例如 D:\\servers\\survival">
              <Input value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder="输入绝对路径" />
            </Field>
          </div>
          <Button variant="secondary" loading={probeMutation.isPending} onClick={() => probeMutation.mutate()} disabled={!rootPath.trim()}>
            检测目录
          </Button>
        </div>

        {probe && (
          <>
            <div className="grid gap-2 rounded-lg bg-[var(--surface-2)] p-4 text-sm sm:grid-cols-2">
              <div>启动脚本：{probe.detected.startScripts.join(', ') || '未找到'}</div>
              <div>服务端 JAR：{probe.detected.serverJars.join(', ') || '未找到'}</div>
              <div>存档目录：{probe.detected.levelName}</div>
              <div>端口：{probe.detected.serverPort}</div>
              <div>EULA：{probe.detected.eula ? '已接受' : '未接受'}</div>
              <div>RCON：{probe.detected.enableRcon ? `已启用（${probe.detected.rconPort}）` : '未启用'}</div>
              <div>Java：{probe.java ? `Java ${probe.java.major}` : '未找到'}</div>
              <div>模组：{probe.detected.hasMods ? '有 mods 目录' : '无'}</div>
            </div>

            {probe.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-[var(--warn)]">
                {probe.warnings.map((warning) => <div key={warning.code}>{warning.message}</div>)}
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="实例名称"><Input value={name} onChange={(event) => setName(event.target.value)} /></Field>
              <Field label="停止超时（秒）"><Input type="number" min={10} max={300} value={stopTimeout} onChange={(event) => setStopTimeout(Number(event.target.value))} /></Field>
              <Field label="启动命令" hint="以面板进程权限执行"><Input value={startCommand} onChange={(event) => setStartCommand(event.target.value)} placeholder="run.bat" /></Field>
              <Field label="Java 路径" hint="留空自动探测">
                <Input value={javaPath} onChange={(event) => setJavaPath(event.target.value)} placeholder="自动" />
              </Field>
              <Field label="日志编码">
                <select className="h-10 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3" value={encoding} onChange={(event) => setEncoding(event.target.value as 'utf-8' | 'gbk')}>
                  <option value="utf-8">UTF-8</option>
                  <option value="gbk">GBK</option>
                </select>
              </Field>
            </div>
            {!probe.detected.eula && <p className="text-xs text-[var(--warn)]">eula.txt 尚未接受，启动会被面板拦截。阶段 2 将提供接受按钮。</p>}
          </>
        )}

        {error && <ErrorState message={error} />}
      </div>
    </Dialog>
  );
}
```

`apps/web/src/pages/InstancesPage.tsx`：

```tsx
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import { useState } from 'react';
import type { InstanceInfo } from '@mcpanel/shared';
import { api } from '../api/client';
import { CreateInstanceDialog } from '../components/CreateInstanceDialog';
import { StatusBadge } from '../components/StatusBadge';
import { Button, EmptyState, ErrorState, Input, Spinner } from '../components/ui';

export function InstancesPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState('');
  const query = useQuery({ queryKey: ['instances'], queryFn: () => api.get<{ items: InstanceInfo[] }>('/instances') });
  const items = (query.data?.items ?? []).filter((instance) => instance.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">实例</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">纳管并管理本机的 Minecraft 服务器</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />纳管实例</Button>
      </div>

      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted)]" />
        <Input className="pl-9" placeholder="搜索实例名称" value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>

      {query.isLoading ? (
        <Spinner />
      ) : query.isError ? (
        <ErrorState message="实例列表加载失败" />
      ) : items.length ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((instance) => (
            <Link key={instance.id} to={`/instances/${instance.id}/overview`} className="group rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 transition hover:border-[var(--primary)]">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-medium group-hover:text-[var(--primary)]">{instance.name}</div>
                  <div className="mt-1 truncate text-xs text-[var(--muted)]">{instance.rootPath}</div>
                </div>
                <StatusBadge state={instance.state} />
              </div>
              <div className="mt-4 flex items-center justify-between text-xs text-[var(--muted)]">
                <span>{instance.pid ? `PID ${instance.pid}` : '无进程'}</span>
                <span className="console-font">{instance.startCommand}</span>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState
          title={search ? '没有匹配的实例' : '还没有纳管实例'}
          description={search ? '换一个关键字试试。' : '选择已有的服务器目录，填写启动命令即可开始管理。'}
          action={!search && <Button onClick={() => setCreateOpen(true)}>纳管第一个实例</Button>}
        />
      )}

      <CreateInstanceDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
```

- [ ] **Step 4: 实现实例布局与概览**

`apps/web/src/layouts/InstanceLayout.tsx`：

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PanelRight, Play, RotateCw, Square, Skull, Wrench } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, Outlet, useParams } from 'react-router-dom';
import type { InstanceInfo, InstanceStatusSnapshot } from '@mcpanel/shared';
import { api, ApiError } from '../api/client';
import { StatusBadge } from '../components/StatusBadge';
import { Button, ConfirmDialog, ErrorState, Spinner, toast } from '../components/ui';
import { useInstanceStatus } from '../stores/realtime';
import { cn } from '../utils/cn';

export interface InstanceOutletContext {
  instance: InstanceInfo;
  status: InstanceStatusSnapshot;
}

const tabs = [
  { to: 'overview', label: '概览' },
];

export function InstanceLayout() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const live = useInstanceStatus(id);
  const query = useQuery({
    queryKey: ['instances', id],
    queryFn: () => api.get<InstanceInfo>(`/instances/${id}`),
    enabled: Boolean(id),
  });
  const [rightOpen, setRightOpen] = useState(
    () => localStorage.getItem('mcpanel:right-panel') !== 'closed' && window.innerWidth >= 1024,
  );
  const [killOpen, setKillOpen] = useState(false);
  const [markOpen, setMarkOpen] = useState(false);

  const action = useMutation({
    mutationFn: (name: 'start' | 'stop' | 'restart' | 'kill') => api.post(`/instances/${id}/actions/${name}`),
    onSuccess: async (_data, name) => {
      await queryClient.invalidateQueries({ queryKey: ['instances'] });
      toast(`已执行${name === 'start' ? '启动' : name === 'stop' ? '停止' : name === 'restart' ? '重启' : '强制结束'}`, 'success');
      setKillOpen(false);
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '操作失败', 'error'),
  });

  const markStopped = useMutation({
    mutationFn: () => api.post(`/instances/${id}/actions/mark-stopped`, { confirm: true }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['instances'] });
      toast('已标记为停止', 'success');
      setMarkOpen(false);
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '操作失败', 'error'),
  });

  if (query.isLoading) return <div className="p-8"><Spinner /></div>;
  if (query.isError || !query.data) return <div className="p-8"><ErrorState message="实例加载失败或不存在" /></div>;

  const instance = query.data;
  const status: InstanceStatusSnapshot = live ?? {
    instanceId: instance.id,
    state: instance.state,
    pid: instance.pid,
    startedAt: instance.startedAt,
    exitCode: instance.exitCode,
    error: instance.lastError,
  };
  const state = status.state;
  const busy = ['starting', 'stopping'].includes(state) || action.isPending;

  const toggleRight = () => {
    const next = !rightOpen;
    setRightOpen(next);
    localStorage.setItem('mcpanel:right-panel', next ? 'open' : 'closed');
  };

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link to="/instances" className="text-xs text-[var(--muted)] hover:text-[var(--primary)]">← 全部实例</Link>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="truncate text-2xl font-semibold">{instance.name}</h1>
            <StatusBadge state={state} />
          </div>
          <div className="mt-1 truncate text-xs text-[var(--muted)]">{instance.rootPath}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {state === 'stopped' || state === 'crashed' ? (
            <Button loading={action.isPending && action.variables === 'start'} disabled={busy} onClick={() => action.mutate('start')}>
              <Play className="h-4 w-4" />启动
            </Button>
          ) : (
            <Button variant="secondary" loading={action.isPending && action.variables === 'stop'} disabled={busy || state === 'unknown'} onClick={() => action.mutate('stop')}>
              <Square className="h-4 w-4" />停止
            </Button>
          )}
          <Button variant="secondary" disabled={busy || !['running', 'orphaned', 'stopped', 'crashed'].includes(state)} onClick={() => action.mutate('restart')}>
            <RotateCw className="h-4 w-4" />重启
          </Button>
          <Button variant="secondary" disabled={!status.pid || state === 'stopped'} onClick={() => setKillOpen(true)}>
            <Skull className="h-4 w-4" />强制结束
          </Button>
          {state === 'unknown' && (
            <Button variant="secondary" onClick={() => setMarkOpen(true)}><Wrench className="h-4 w-4" />标记已停止</Button>
          )}
          <Button variant="ghost" onClick={toggleRight} aria-label="切换右侧面板"><PanelRight className="h-4 w-4" /></Button>
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-[var(--border)]">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              cn(
                'whitespace-nowrap border-b-2 px-4 py-2 text-sm transition',
                isActive ? 'border-[var(--primary)] text-[var(--primary)]' : 'border-transparent text-[var(--muted)] hover:text-[var(--fg)]',
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </div>

      <div className="flex min-w-0 gap-5">
        <div className="min-w-0 flex-1">
          <Outlet context={{ instance, status } satisfies InstanceOutletContext} />
        </div>
        {rightOpen && (
          <aside className="hidden w-72 shrink-0 lg:block">
            <div className="sticky top-4 flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm">
              <div className="font-medium">运行状态</div>
              <div className="flex justify-between text-[var(--muted)]"><span>状态</span><StatusBadge state={state} /></div>
              <div className="flex justify-between text-[var(--muted)]"><span>PID</span><span>{status.pid ?? '—'}</span></div>
              <div className="flex justify-between text-[var(--muted)]"><span>RCON</span><span>{instance.rconStatus}</span></div>
              <div className="flex justify-between text-[var(--muted)]"><span>启动命令</span><span className="console-font max-w-[60%] truncate" title={instance.startCommand}>{instance.startCommand}</span></div>
              {status.error && <div className="rounded-md bg-red-500/10 p-2 text-xs text-[var(--danger)]">{status.error}</div>}
              <Link to="console" className="inline-flex h-9 w-full items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-2)] text-sm">打开控制台</Link>
            </div>
          </aside>
        )}
      </div>

      <ConfirmDialog
        open={killOpen}
        onOpenChange={setKillOpen}
        title="强制结束进程树"
        description="这会立即杀死服务器及其子进程，可能造成存档未保存。确定继续？"
        confirmLabel="强制结束"
        danger
        loading={action.isPending && action.variables === 'kill'}
        onConfirm={() => action.mutate('kill')}
      />
      <ConfirmDialog
        open={markOpen}
        onOpenChange={setMarkOpen}
        title="标记为已停止"
        description="仅在确认操作系统中的进程已经不存在时使用，否则会丢失对该进程的跟踪。"
        confirmLabel="确认已停止"
        danger
        loading={markStopped.isPending}
        onConfirm={() => markStopped.mutate()}
      />
    </div>
  );
}
```

`apps/web/src/pages/instance/OverviewTab.tsx`：

```tsx
import { Link, useOutletContext } from 'react-router-dom';
import type { InstanceOutletContext } from '../../layouts/InstanceLayout';
import { MetricsSparkline } from '../../components/MetricsSparkline';
import { useInstanceConsole, useInstanceMetrics } from '../../stores/realtime';
import { formatBytes, formatDuration } from '../../utils/format';

export function OverviewTab() {
  const { instance, status } = useOutletContext<InstanceOutletContext>();
  const metrics = useInstanceMetrics(instance.id);
  const consoleState = useInstanceConsole(instance.id);
  const uptime = status.startedAt && ['running', 'orphaned'].includes(status.state)
    ? (Date.now() - new Date(status.startedAt).getTime()) / 1000
    : null;
  const latest = metrics.at(-1);

  return (
    <div className="flex flex-col gap-4">
      {status.error && <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-[var(--warn)]">{status.error}</div>}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="text-xs text-[var(--muted)]">PID / 运行时长</div>
          <div className="mt-2 text-lg font-semibold tabular-nums">{status.pid ?? '—'}</div>
          <div className="text-xs text-[var(--muted)]">{uptime ? formatDuration(uptime) : '未运行'}</div>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="text-xs text-[var(--muted)]">CPU</div>
          <div className="mt-2 text-lg font-semibold tabular-nums">{latest ? `${latest.cpu.toFixed(1)}%` : '—'}</div>
          <div className="text-xs text-[var(--muted)]">{latest ? formatBytes(latest.memBytes) : '等待采样'}</div>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="text-xs text-[var(--muted)]">RCON</div>
          <div className="mt-2 text-lg font-semibold">{instance.rconStatus}</div>
          <div className="text-xs text-[var(--muted)]">玩家功能在阶段 2 提供</div>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="text-xs text-[var(--muted)]">日志编码</div>
          <div className="mt-2 text-lg font-semibold">{instance.logEncoding}</div>
          <div className="text-xs text-[var(--muted)]">启动命令：{instance.startCommand}</div>
        </div>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="font-medium">CPU 采样</span>
          <span className="text-xs text-[var(--muted)]">最近 {metrics.length} 个样本</span>
        </div>
        <MetricsSparkline values={metrics.map((sample) => sample.cpu)} height={60} />
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <span className="text-sm font-medium">最近控制台</span>
          <Link to="../console" className="text-sm text-[var(--primary)] hover:underline">打开控制台 →</Link>
        </div>
        <pre className="console-font max-h-64 overflow-auto p-4 text-xs leading-5 text-[var(--muted)]">
          {consoleState.lines.slice(-20).map((line) => `${line.text}\n`).join('') || '暂无日志'}
        </pre>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm">
        <div className="mb-3 font-medium">实例信息</div>
        <dl className="grid gap-2 sm:grid-cols-2">
          <div className="flex gap-2"><dt className="text-[var(--muted)]">根目录</dt><dd className="truncate">{instance.rootPath}</dd></div>
          <div className="flex gap-2"><dt className="text-[var(--muted)]">Java</dt><dd className="truncate">{instance.javaPath ?? '自动探测'}</dd></div>
          <div className="flex gap-2"><dt className="text-[var(--muted)]">停止超时</dt><dd>{instance.stopTimeoutSec} 秒</dd></div>
          <div className="flex gap-2"><dt className="text-[var(--muted)]">RCON 主机</dt><dd>{instance.rconHost ?? '自动'}</dd></div>
        </dl>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 更新路由**

把 `apps/web/src/router.tsx` 中的受保护路由区块改为：

```tsx
import { InstancesPage } from './pages/InstancesPage';
import { InstanceLayout } from './layouts/InstanceLayout';
import { OverviewTab } from './pages/instance/OverviewTab';

// ...
      <Route path="/" element={<RequireAuth><AppShell /></RequireAuth>}>
        <Route index element={<DashboardPage />} />
        <Route path="instances" element={<InstancesPage />} />
        <Route path="instances/:id" element={<InstanceLayout />}>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<OverviewTab />} />
        </Route>
      </Route>
```

- [ ] **Step 6: 运行测试与类型检查**

Run: `npm test -w @mcpanel/web && npm run typecheck -w @mcpanel/web`
Expected: 4 个测试 PASS（dialog 1、status badge 1、realtime 2）；typecheck 无输出。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/pages apps/web/src/components/CreateInstanceDialog.tsx apps/web/src/layouts/InstanceLayout.tsx apps/web/src/router.tsx apps/web/test/create-instance-dialog.test.tsx
git commit -m "feat(web): add instance list, onboarding dialog, layout and overview"
```

---

## Task 15: 控制台页、命令输入与实例设置

**Files:**
- Create: `apps/web/src/components/ConsoleViewer.tsx`, `apps/web/src/components/CommandInput.tsx`, `apps/web/src/pages/instance/ConsoleTab.tsx`, `apps/web/src/pages/instance/InstanceSettingsTab.tsx`
- Modify: `apps/web/src/router.tsx`
- Test: `apps/web/test/console-filter.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/web/test/console-filter.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { ConsoleLine } from '@mcpanel/shared';
import { filterConsoleLines } from '../src/components/ConsoleViewer';

const lines: ConsoleLine[] = [
  { seq: 1, ts: '', stream: 'stdout', level: 'info', text: 'Done (12.4s)!' },
  { seq: 2, ts: '', stream: 'stdout', level: 'warn', text: 'Can\'t keep up' },
  { seq: 3, ts: '', stream: 'stderr', level: 'error', text: 'Address already in use' },
];

describe('filterConsoleLines', () => {
  it('filters by level and case-insensitive search', () => {
    expect(filterConsoleLines(lines, 'error', '').map((line) => line.seq)).toEqual([3]);
    expect(filterConsoleLines(lines, 'all', 'address').map((line) => line.seq)).toEqual([3]);
    expect(filterConsoleLines(lines, 'all', '')).toHaveLength(3);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/web -- test/console-filter.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现控制台组件**

`apps/web/src/components/ConsoleViewer.tsx`：

```tsx
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConsoleLine } from '@mcpanel/shared';
import { Button } from './ui';
import { cn } from '../utils/cn';

export type ConsoleLevelFilter = 'all' | 'info' | 'warn' | 'error';

export function filterConsoleLines(lines: ConsoleLine[], level: ConsoleLevelFilter, search: string): ConsoleLine[] {
  const needle = search.trim().toLowerCase();
  return lines.filter(
    (line) => (level === 'all' || line.level === level) && (needle === '' || line.text.toLowerCase().includes(needle)),
  );
}

export function ConsoleViewer({
  lines,
  gap,
  onDownload,
}: {
  lines: ConsoleLine[];
  gap: boolean;
  onDownload: () => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [level, setLevel] = useState<ConsoleLevelFilter>('all');
  const [search, setSearch] = useState('');
  const [follow, setFollow] = useState(true);
  const filtered = useMemo(() => filterConsoleLines(lines, level, search), [lines, level, search]);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 20,
    overscan: 30,
  });

  useEffect(() => {
    if (!follow) return;
    const element = parentRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [filtered.length, follow]);

  const handleScroll = () => {
    const element = parentRef.current;
    if (!element) return;
    setFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 40);
  };

  const jumpToLatest = () => {
    const element = parentRef.current;
    if (element) element.scrollTop = element.scrollHeight;
    setFollow(true);
  };

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="日志级别"
          className="h-9 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-sm"
          value={level}
          onChange={(event) => setLevel(event.target.value as ConsoleLevelFilter)}
        >
          <option value="all">全部级别</option>
          <option value="info">INFO</option>
          <option value="warn">WARN</option>
          <option value="error">ERROR</option>
        </select>
        <input
          aria-label="搜索日志"
          placeholder="搜索日志"
          className="h-9 w-56 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm focus:border-[var(--primary)] focus:outline-none"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Button variant="secondary" onClick={onDownload}>下载日志</Button>
        {!follow && <Button onClick={jumpToLatest}>回到最新</Button>}
      </div>

      {gap && <div className="text-xs text-[var(--warn)]">部分历史日志已丢失，显示的是当前缓冲区内容。</div>}

      <div
        ref={parentRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        className="console-font h-[calc(100vh-23rem)] min-h-64 overflow-auto rounded-lg border border-[var(--border)] bg-[#050806] p-3 text-xs leading-5 text-[#cfe3d4]"
      >
        {filtered.length === 0 ? (
          <div className="text-[var(--muted)]">暂无日志</div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const line = filtered[item.index]!;
              return (
                <div
                  key={line.seq}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
                  className={cn(
                    'whitespace-pre-wrap break-all',
                    line.level === 'error' && 'text-red-400',
                    line.level === 'warn' && 'text-amber-300',
                    line.stream === 'rcon' && 'text-emerald-300',
                  )}
                >
                  {line.text}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
```

`apps/web/src/components/CommandInput.tsx`：

```tsx
import { useState, type KeyboardEvent } from 'react';
import { SendHorizontal } from 'lucide-react';
import { Button, Input } from './ui';

function historyKey(instanceId: string): string {
  return `mcpanel:command-history:${instanceId}`;
}

function loadHistory(instanceId: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(historyKey(instanceId)) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 100) : [];
  } catch {
    return [];
  }
}

export function CommandInput({
  instanceId,
  disabled,
  onSend,
}: {
  instanceId: string;
  disabled: boolean;
  onSend: (command: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [history, setHistory] = useState<string[]>(() => loadHistory(instanceId));
  const [index, setIndex] = useState(-1);
  const [sending, setSending] = useState(false);

  const send = async () => {
    const command = value.trim();
    if (!command || disabled || sending) return;
    setSending(true);
    try {
      await onSend(command);
      const next = [command, ...history.filter((item) => item !== command)].slice(0, 100);
      setHistory(next);
      localStorage.setItem(historyKey(instanceId), JSON.stringify(next));
      setValue('');
      setIndex(-1);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void send();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      const next = Math.min(history.length - 1, index + 1);
      const previous = history[next];
      if (previous !== undefined) {
        setIndex(next);
        setValue(previous);
      }
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = index - 1;
      setIndex(next);
      setValue(next >= 0 ? history[next] ?? '' : '');
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label="服务器命令"
        className="console-font"
        placeholder={disabled ? '服务器未运行，无法发送命令' : '输入命令后回车，例如 say hello'}
        value={value}
        disabled={disabled || sending}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <Button onClick={() => void send()} disabled={disabled || !value.trim()} loading={sending} aria-label="发送命令">
        <SendHorizontal className="h-4 w-4" />
      </Button>
    </div>
  );
}
```

`apps/web/src/pages/instance/ConsoleTab.tsx`：

```tsx
import { useMutation } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import type { InstanceOutletContext } from '../../layouts/InstanceLayout';
import { api, ApiError } from '../../api/client';
import { CommandInput } from '../../components/CommandInput';
import { ConsoleViewer } from '../../components/ConsoleViewer';
import { ErrorState, toast } from '../../components/ui';
import { useInstanceConsole } from '../../stores/realtime';

export function ConsoleTab() {
  const { instance, status } = useOutletContext<InstanceOutletContext>();
  const consoleState = useInstanceConsole(instance.id);
  const send = useMutation({
    mutationFn: (command: string) => api.post(`/instances/${instance.id}/console/command`, { command }),
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '命令发送失败', 'error'),
  });
  const commandDisabled = !['running', 'orphaned'].includes(status.state);

  return (
    <div className="flex flex-col gap-3">
      {status.state === 'stopped' && <ErrorState message="服务器未运行。启动后可发送命令。" />}
      {status.state === 'orphaned' && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-[var(--warn)]">
          控制台未接管，命令将通过 RCON 发送。
        </div>
      )}
      <ConsoleViewer
        lines={consoleState.lines}
        gap={consoleState.gap}
        onDownload={() => {
          window.location.href = `/api/instances/${instance.id}/logs/download`;
        }}
      />
      <CommandInput
        instanceId={instance.id}
        disabled={commandDisabled}
        onSend={(command) => send.mutateAsync(command).then(() => undefined).catch(() => undefined)}
      />
    </div>
  );
}
```

- [ ] **Step 4: 实现实例设置页**

`apps/web/src/pages/instance/InstanceSettingsTab.tsx`：

```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import type { InstanceOutletContext } from '../../layouts/InstanceLayout';
import { api, ApiError } from '../../api/client';
import { Button, ConfirmDialog, ErrorState, Field, Input, toast } from '../../components/ui';

export function InstanceSettingsTab() {
  const { instance } = useOutletContext<InstanceOutletContext>();
  const [form, setForm] = useState({
    name: instance.name,
    startCommand: instance.startCommand,
    javaPath: instance.javaPath ?? '',
    stopTimeoutSec: instance.stopTimeoutSec,
    logEncoding: instance.logEncoding,
    rconHost: instance.rconHost ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/instances/${instance.id}`, {
        name: form.name,
        startCommand: form.startCommand,
        javaPath: form.javaPath || null,
        stopTimeoutSec: Number(form.stopTimeoutSec),
        logEncoding: form.logEncoding,
        rconHost: form.rconHost || null,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['instances'] });
      setError(null);
      toast('设置已保存', 'success');
    },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : '保存失败'),
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/instances/${instance.id}`, { confirmName }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['instances'] });
      toast('实例已删除（服务器目录保留）', 'success');
      navigate('/instances');
    },
    onError: (cause) => {
      setDeleteOpen(false);
      toast(cause instanceof ApiError ? cause.message : '删除失败', 'error');
    },
  });

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <form
        className="flex flex-col gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <h2 className="font-semibold">实例设置</h2>
        <Field label="实例名称"><Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
        <Field label="根目录" hint="纳管后不可修改，需要换目录请删除实例后重新纳管">
          <Input value={instance.rootPath} disabled />
        </Field>
        <Field label="启动命令" hint="以面板进程权限执行"><Input value={form.startCommand} onChange={(event) => setForm({ ...form, startCommand: event.target.value })} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Java 路径" hint="留空自动探测"><Input value={form.javaPath} onChange={(event) => setForm({ ...form, javaPath: event.target.value })} /></Field>
          <Field label="RCON 主机" hint="留空从 server-ip 推导"><Input value={form.rconHost} onChange={(event) => setForm({ ...form, rconHost: event.target.value })} /></Field>
          <Field label="停止超时（秒）"><Input type="number" min={10} max={300} value={form.stopTimeoutSec} onChange={(event) => setForm({ ...form, stopTimeoutSec: Number(event.target.value) })} /></Field>
          <Field label="日志编码">
            <select className="h-10 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3" value={form.logEncoding} onChange={(event) => setForm({ ...form, logEncoding: event.target.value as 'utf-8' | 'gbk' })}>
              <option value="utf-8">UTF-8</option>
              <option value="gbk">GBK</option>
            </select>
          </Field>
        </div>
        {error && <ErrorState message={error} />}
        <div><Button type="submit" loading={save.isPending}>保存设置</Button></div>
      </form>

      <div className="rounded-xl border border-[var(--danger)]/30 bg-red-500/5 p-5">
        <h2 className="font-semibold text-[var(--danger)]">删除实例</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">只删除面板中的注册、计划和备份记录，不会删除服务器目录。请先停止服务器。</p>
        <Button variant="danger" className="mt-4" onClick={() => setDeleteOpen(true)}>删除实例</Button>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="删除实例"
        description={`输入实例名称“${instance.name}”以确认。服务器目录会被保留。`}
        confirmLabel="删除"
        danger
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      >
        <Input value={confirmName} onChange={(event) => setConfirmName(event.target.value)} placeholder={instance.name} aria-label="确认实例名称" />
      </ConfirmDialog>
    </div>
  );
}
```

- [ ] **Step 5: 更新路由与页签**

在 `apps/web/src/router.tsx` 的实例路由下追加：

```tsx
import { ConsoleTab } from './pages/instance/ConsoleTab';
import { InstanceSettingsTab } from './pages/instance/InstanceSettingsTab';

// ...
          <Route path="console" element={<ConsoleTab />} />
          <Route path="settings" element={<InstanceSettingsTab />} />
```

同时把 `apps/web/src/layouts/InstanceLayout.tsx` 的 `tabs` 数组补全：

```ts
const tabs = [
  { to: 'overview', label: '概览' },
  { to: 'console', label: '控制台' },
  { to: 'settings', label: '设置' },
];
```

- [ ] **Step 6: 运行测试与类型检查**

Run: `npm test -w @mcpanel/web && npm run typecheck -w @mcpanel/web`
Expected: 5 个测试 PASS（新增 filter 1）；typecheck 无输出。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/components/ConsoleViewer.tsx apps/web/src/components/CommandInput.tsx apps/web/src/pages/instance apps/web/src/router.tsx apps/web/src/layouts/InstanceLayout.tsx apps/web/test/console-filter.test.ts
git commit -m "feat(web): add console viewer, command input and instance settings"
```

---

## Task 16: 启动入口、生产静态托管、README 与阶段验收

**Files:**
- Create: `apps/server/src/index.ts`, `README.md`
- Modify: `apps/server/src/app.ts`, `apps/server/src/config.ts`, `scripts/dev.mjs`, `package.json`
- Test: `apps/server/test/unit/spa.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/server/test/unit/spa.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { shouldServeSpa } from '../../src/app';

describe('shouldServeSpa', () => {
  it('serves SPA for GET navigation but never for API routes', () => {
    expect(shouldServeSpa('/instances/abc/console', 'GET')).toBe(true);
    expect(shouldServeSpa('/api/instances', 'GET')).toBe(false);
    expect(shouldServeSpa('/api/nope', 'GET')).toBe(false);
    expect(shouldServeSpa('/instances', 'POST')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/server -- test/unit/spa.test.ts`
Expected: FAIL，`shouldServeSpa` 未导出。

- [ ] **Step 3: 调整配置默认值与开发脚本**

修改 `apps/server/src/config.ts` 中的 `nodeEnv` 推导：

```ts
  const nodeEnv: AppConfig['nodeEnv'] =
    env.NODE_ENV === 'test' ? 'test' : env.NODE_ENV === 'development' ? 'development' : 'production';
```

修改 `scripts/dev.mjs` 的两个 spawn 调用，显式设置开发环境：

```js
const devEnv = { ...process.env, NODE_ENV: 'development' };

const children = [
  spawn('npm', ['run', 'dev', '-w', '@mcpanel/server'], { stdio: 'inherit', shell: process.platform === 'win32', env: devEnv }),
  spawn('npm', ['run', 'dev', '-w', '@mcpanel/web'], { stdio: 'inherit', shell: process.platform === 'win32', env: devEnv }),
];
```

- [ ] **Step 4: 在生产模式下托管 SPA**

在 `apps/server/src/app.ts` 顶部追加：

```ts
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
```

在 `BuildAppOptions` 中追加：

```ts
  serveStatic?: boolean;
```

在 `buildApp` 内、`setNotFoundHandler` 之前加入静态注册，并替换 `setNotFoundHandler`：

```ts
export function shouldServeSpa(url: string, method: string): boolean {
  return method === 'GET' && !url.startsWith('/api');
}

// ... inside buildApp
  const serveStatic = options.serveStatic ?? true;
  const hasSpa = serveStatic && fs.existsSync(path.join(config.webDistDir, 'index.html'));
  if (hasSpa) {
    await app.register(fastifyStatic, { root: config.webDistDir });
  }

  app.setNotFoundHandler((request, reply) => {
    if (hasSpa && shouldServeSpa(request.url, request.method)) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: '资源不存在' } });
  });
```

- [ ] **Step 5: 实现启动入口**

`apps/server/src/index.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';
import { count } from 'drizzle-orm';
import { assertSafeBind, loadConfig } from './config';
import { createLogger } from './logger';
import { openDatabase } from './db/client';
import { runMigrations, seedLocalNode } from './db/migrate';
import { users } from './db/schema';
import { LoginThrottle } from './auth/guard';
import { SessionService } from './auth/session';
import { LocalNodeDriver } from './nodes/local-driver';
import { PathSandbox } from './nodes/path-sandbox';
import { AuditService } from './services/audit-service';
import { InstanceService } from './services/instance-service';
import { InstanceSupervisor } from './services/instance-supervisor';
import { MetricsService } from './services/metrics-service';
import { ProbeService } from './services/probe-service';
import { RconService } from './services/rcon-service';
import { buildApp } from './app';

const envFile = path.resolve('.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();
const logger = createLogger(config.dataDir, config.logLevel, config.nodeEnv === 'development');
const handle = openDatabase(config.dbPath);
runMigrations(handle.sqlite, config.migrationsDir);
seedLocalNode(handle.db);

const userCount = handle.db.select({ value: count() }).from(users).get()?.value ?? 0;
assertSafeBind(config.host, userCount === 0);

const sessions = new SessionService(handle.db);
const audit = new AuditService(handle.db, logger);
const instances = new InstanceService(handle.db, config.dataDir);
const sandbox = new PathSandbox(config.dataDir);
const driver = new LocalNodeDriver(sandbox);
const rcon = new RconService();
const probe = new ProbeService(sandbox);
const supervisor = new InstanceSupervisor({
  db: handle.db,
  driver,
  rcon,
  audit,
  logger,
  dataDir: config.dataDir,
});

await supervisor.init();
const metrics = new MetricsService({ supervisor, db: handle.db, dataDir: config.dataDir });
const app = await buildApp(
  config,
  handle.db,
  {
    sessions,
    audit,
    loginThrottle: new LoginThrottle(),
    instances,
    supervisor,
    rcon,
    driver,
    probe,
    metrics,
  },
  { logger },
);

await app.listen({ host: config.host, port: config.port });
logger.info({ host: config.host, port: config.port, dataDir: config.dataDir }, 'MC Panel started');

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down panel; Minecraft servers keep running');
  await supervisor.shutdown();
  await app.close();
  handle.sqlite.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
```

- [ ] **Step 6: 写 README**

`README.md`：

```markdown
# MC Panel

自托管的 Minecraft Java 模组服管理面板。第一版支持单管理员、单机节点，纳管已有的 Fabric / Forge / NeoForge 服务器目录。

## 当前阶段（阶段 1）

- 首次初始化、登录、会话与 CSRF 防护
- 纳管已有服务器目录（自动探测启动脚本、Java、properties、EULA、RCON）
- 启动 / 停止 / 重启 / 强制结束，状态机与面板重启后的孤儿进程恢复
- 实时控制台、命令输入、日志下载、WARN/ERROR 过滤
- 仪表盘系统指标与实例指标
- 路径沙箱与审计基础

玩家管理、文件管理、配置编辑在阶段 2；备份、计划任务、Windows 一键启动在阶段 3。

## 环境要求

- Node.js 22+（推荐 24 LTS）
- Windows 10/11 或主流 Linux
- 已经在同一台机器上安装好 Java 与 Minecraft 服务端

## 开发

```bash
npm install
npm run dev
```

- 后端：`http://127.0.0.1:3000`
- 前端：`http://127.0.0.1:5173`（代理 `/api` 和 WebSocket）
- 开发数据目录：`./data`（可用 `DATA_DIR=./data-dev` 区分）

## 生产

```bash
npm run build
npm start
```

访问 `http://127.0.0.1:3000`。首次打开会进入初始化页面。生产构建会由 Fastify 托管 `apps/web/dist`，刷新任意前端路由不会 404。

## 数据目录

```text
data/
├─ panel.db        SQLite 元数据
├─ secret.key      自动生成的会话密钥（勿泄露）
├─ backups/        备份（阶段 3）
├─ tmp/            临时文件
└─ logs/panel.log  面板日志（10 MB 轮转）
```

## 安全

- 默认只监听 `127.0.0.1`；在完成初始化前拒绝绑定非回环地址。
- 面板以系统账号权限运行，建议使用专用低权限账号，并且只授予实例目录的读写权限。
- 所有实例文件操作都会被路径沙箱限制在实例根目录内；符号链接会被拒绝。
- 不要把 `data/` 放在实例目录内，也不要让实例目录互相嵌套。
- 直接关闭面板不会停止 Minecraft 服务器；服务器会在面板重启后被识别为 `orphaned` / `unknown` 并提示处理。
- HTTPS 请使用反向代理，并设置 `COOKIE_SECURE=true`。

## 测试

```bash
npm run typecheck
npm test
npm run lint
```

## 忘记密码

阶段 1 尚未提供重置脚本，忘记密码时可停止面板并删除 `data/panel.db` 中的 `users` 与会话记录（会丢失实例注册），然后重新初始化。阶段 3 提供 `scripts/reset-password.mjs`。
```

- [ ] **Step 7: 运行全部验证**

Run:

```bash
npm run typecheck
npm test
npm run lint
npm run build
```

Expected:

- `typecheck` 无输出。
- `npm test`：shared 6 个测试、server 全部单元/集成测试、web 5 个测试全部 PASS。
- `lint` 无 error（若报未使用 import，按其提示删除；测试中的 `any` 若被规则拦截，改为具体类型）。
- `build` 生成 `apps/web/dist/index.html` 与 `apps/server/dist/index.js`。

启动冒烟：

```bash
DATA_DIR=./data-dev PANEL_PORT=3001 npm start
```

Expected: 控制台打印 `MC Panel started`；浏览器打开 `http://127.0.0.1:3001` 显示初始化页；注册管理员、纳管一个测试目录、启动/停止、看到控制台输出；刷新 `/instances` 不出现 404。按 Ctrl+C 后确认测试 Minecraft 进程仍在运行（用任务管理器/PID 检查），面板日志提示 `Minecraft servers keep running`。

- [ ] **Step 8: 提交**

```bash
git add apps/server/src/index.ts apps/server/src/app.ts apps/server/src/config.ts apps/server/test/unit/spa.test.ts scripts/dev.mjs README.md
git commit -m "feat: add production entry, SPA hosting, README and phase 1 acceptance"
```

---

## 阶段 1 规格覆盖对照

| 规格章节 | 任务 |
| --- | --- |
| 5 技术选型 | 1 |
| 6 架构与 NodeDriver 边界 | 7、9（RCON 由服务层实现，Agent 扩展留到后续） |
| 7 目录结构 | 1–16 |
| 8 数据模型 | 2 |
| 9 状态机、启动/停止/恢复、控制台 | 6、7、8、9 |
| 10 RCON（连接、测试、孤儿停止） | 8、9；玩家管理与一键启用属阶段 2 |
| 11 路径沙箱 | 6；文件 CRUD/模组/properties 编辑属阶段 2 |
| 14 指标与仪表盘 | 12、13 |
| 15 认证、会话、CSRF、审计 | 5、10；审计页面属阶段 2 |
| 16 API（认证/实例/审计/系统） | 10、11、12 |
| 17 WebSocket（console/status/metrics/system） | 12 |
| 18 前端（外壳、实例页、控制台、仪表盘） | 13、14、15 |
| 19 安全（路径、CSRF、Origin、RCON 密码不落库） | 6、8、10 |
| 20.1–20.3 环境变量、开发、构建 | 1、3、16 |
| 20.4–20.6 Windows bat、systemd、升级 | 阶段 3 |
| 21 测试（单元/集成） | 各任务内；Playwright 冒烟属阶段 3 |
| 22 阶段 1 验收 | 16 |

## 计划自审记录

- 所有任务包含确切文件路径、失败测试、实现代码、运行命令与预期结果。
- 类型名、字段名和接口在任务之间保持一致：`InstanceInfo`、`InstanceStatusSnapshot`、`ConsoleLine`、`MetricsCollector`、`SupervisorDeps`。
- 测试与实现中的偏差已显式标注（`mark-stopped` 请求体、`pong` 消息、RCON 假服务端、WS 测试桩），执行时必须按标注修正，不要保留临时写法。
- 阶段 1 明确不包含玩家/文件/配置/备份/计划 UI 与 API；这些在阶段 2、3 计划中补齐，避免半成品入口。
- 目录不是 git 仓库，Task 1 会执行 `git init`；提交步骤按任务拆分。
- 与规格的已确认实现差异：`NodeDriver` 在阶段 1 只覆盖进程、只读文件与路径校验，完整接口在阶段 2/3 扩展；RCON 由 `RconService` 承担（规格服务层同样列出 RCON）；WS 指标消息用 `sample` 嵌套承载复用类型，频道与字段语义不变；补充了规格前端要求但 API 表遗漏的 `GET /api/instances/:id/logs/download`。
