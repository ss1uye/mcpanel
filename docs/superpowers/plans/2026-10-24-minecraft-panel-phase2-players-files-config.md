# 阶段 2（玩家、文件与配置）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在阶段 1 的面板上补齐玩家管理、文件管理、`server.properties` 配置编辑、EULA、审计页与面板设置，使单管理员可以完成日常运维闭环。

**Architecture:** 沿用阶段 1 的分层：`routes/*` 只做鉴权/校验/审计，`services/*` 承载业务，`nodes/*` 只碰文件系统与进程。文件写操作全部经过 `PathSandbox.resolve`；属性文件通过纯函数补丁保留注释、顺序与换行风格；RCON 操作由 `RconService` 承担，玩家动作只使用固定命令模板。

**Tech Stack:** Fastify 5、@fastify/multipart、yauzl、better-sqlite3 + drizzle、zod、React 19、TanStack Query 5、Zustand 5、Radix DropdownMenu、Tailwind 4。

---

## 阶段边界

本计划只做规格 §22「阶段 2」：RCON 玩家管理与一键启用、文件浏览/上传/下载/编辑/重命名/删除/解压、`mods/` 启停、`server.properties` 表单与原始编辑、EULA、审计页、面板设置（含改密码，补阶段 1 的 API 空缺）。备份、计划任务、部署脚本仍属阶段 3，**不要**在本阶段引入。

## 文件结构

```text
packages/shared/src/
├─ types.ts                       # + 文件/玩家/配置/设置响应类型
└─ schemas/
   ├─ files.ts                    # 新增：路径、保存、上传、解压、模组、properties、EULA
   ├─ players.ts                  # 新增：玩家动作判别联合
   ├─ settings.ts                 # 新增：面板设置
   └─ common.ts                   # 修改：审计 action 前缀过滤注释

apps/server/src/
├─ utils/fs-atomic.ts             # 新增：原子写文件（同目录临时文件 + rename）
├─ services/
│  ├─ file-service.ts             # 新增：列表/读取/保存/建目录/改名/删除/解压/模组启停
│  ├─ properties-patch.ts         # 新增：纯函数补丁（保留注释/顺序/EOL/重复键）
│  ├─ rcon-config-service.ts      # 新增：一键启用 RCON
│  ├─ players-service.ts          # 新增：list 解析、名单文件、动作命令
│  └─ settings-service.ts         # 新增：settings 表读写
├─ routes/
│  ├─ files.ts                    # 新增：/api/instances/:id/files*
│  ├─ config.ts                   # 新增：/api/instances/:id/config*
│  ├─ players.ts                  # 新增：/api/instances/:id/players*、/rcon*
│  └─ settings.ts                 # 新增：/api/settings
├─ app.ts                         # 修改：注册 multipart、files/config/players/settings 路由
└─ index.ts                       # 修改：构造 FileService/PlayersService/SettingsService/RconConfigService

apps/web/src/
├─ components/
│  ├─ PlayerAvatar.tsx            # 新增：本地像素头像
│  ├─ PlayerList.tsx              # 新增：在线列表 + 动作菜单
│  ├─ RconEnableDialog.tsx        # 新增：一键启用 RCON
│  ├─ FileBrowser.tsx             # 新增：面包屑/列表/上传/操作
│  ├─ FileEditorDialog.tsx        # 新增：文本编辑 + mtime 冲突
│  ├─ PropertiesForm.tsx          # 新增：分组表单
│  └─ InstanceRightPanel.tsx      # 新增：右侧玩家面板
├─ pages/
│  ├─ AuditPage.tsx               # 新增：审计
│  ├─ SettingsPage.tsx            # 新增：面板设置 + 改密码
│  └─ instance/
│     ├─ PlayersTab.tsx           # 新增
│     ├─ FilesTab.tsx             # 新增
│     └─ ConfigTab.tsx            # 新增
├─ layouts/{AppShell,InstanceLayout}.tsx  # 修改：导航、页签、右侧面板
└─ router.tsx                     # 修改：新路由
```

## 约定（执行前必读）

- 文件接口的 `path` 一律是**以 `/` 开头的实例内相对路径**（`'/'` 表示实例根）。服务端用 `PathSandbox.normalizeRelative` 归一化，写入路径必须经过 `resolve`。
- 所有写接口：`{ preHandler: [requireOrigin, requireAuth, app.csrfProtection] }`，并写审计；所有读接口只要求 `requireAuth`。
- 审计动作命名沿用点号：`file.save`、`file.upload`、`file.delete`、`config.update`、`instance.eula_accept`、`instance.rcon_enable`、`player.kick`、`settings.update`。
- 前端错误提示统一 `cause instanceof ApiError ? cause.message : '…失败'`；破坏性操作必须 `ConfirmDialog`，删除目录/删除实例要求输入名称。
- 每个任务结束时：`npm run typecheck && npm test && npm run lint` 全绿后再提交。

---

### Task 1: 共享契约（类型与 schema）

**Files:**
- Modify: `packages/shared/src/types.ts`
- Create: `packages/shared/src/schemas/files.ts`
- Create: `packages/shared/src/schemas/players.ts`
- Create: `packages/shared/src/schemas/settings.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/schemas.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/shared/test/schemas.test.ts` **顶部**补充 import：

```ts
import { playerActionSchema } from '../src/schemas/players';
import { filePathSchema, saveFileSchema, renameSchema } from '../src/schemas/files';
import { panelSettingsSchema } from '../src/schemas/settings';
```

在文件末尾追加：

```ts
describe('phase 2 schemas', () => {
  it('accepts only whitelisted player actions with sanitized reasons', () => {
    expect(playerActionSchema.parse({ action: 'kick', player: 'Steve', reason: '挂机\n刷屏' })).toEqual({
      action: 'kick',
      player: 'Steve',
      reason: '挂机 刷屏',
    });
    expect(playerActionSchema.parse({ action: 'gamemode', player: 'Alex', mode: 'creative' })).toMatchObject({
      mode: 'creative',
    });
    expect(() => playerActionSchema.parse({ action: 'op', player: 'bad name' })).toThrow();
    expect(() => playerActionSchema.parse({ action: 'say_all', message: 'x' })).toThrow();
    expect(playerActionSchema.parse({ action: 'broadcast', message: '维护 5 分钟' })).toEqual({
      action: 'broadcast',
      message: '维护 5 分钟',
    });
  });

  it('defaults file paths to the instance root and rejects traversal', () => {
    expect(filePathSchema.parse(undefined)).toBe('/');
    expect(filePathSchema.parse('/mods')).toBe('/mods');
    expect(() => filePathSchema.parse('../etc')).toThrow();
    expect(() => filePathSchema.parse('a/../../b')).toThrow();
    expect(() => filePathSchema.parse('/a\0b')).toThrow();
    expect(saveFileSchema.parse({ path: '/ops.json', content: '[]', expectedMtime: 1 })).toMatchObject({
      expectedMtime: 1,
    });
    expect(() => renameSchema.parse({ path: '/a.txt', newName: '../b.txt' })).toThrow();
    expect(() => renameSchema.parse({ path: '/a.txt', newName: 'b/c.txt' })).toThrow();
  });

  it('validates panel settings', () => {
    expect(
      panelSettingsSchema.parse({ panelName: '我的面板', defaultTimezone: 'Asia/Shanghai', auditRetentionDays: 30 }),
    ).toMatchObject({ auditRetentionDays: 30 });
    expect(() => panelSettingsSchema.partial().parse({ defaultTimezone: 'Not/AZone' })).toThrow();
    expect(() => panelSettingsSchema.partial().parse({ auditRetentionDays: 0 })).toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/shared`
Expected: FAIL，`../src/schemas/players` 等模块不存在。

- [ ] **Step 3: 实现类型与 schema**

在 `packages/shared/src/types.ts` 末尾追加：

```ts
export interface FileEntryInfo {
  name: string;
  type: 'file' | 'directory';
  size: number;
  mtime: string;
  symlink: boolean;
  editable: boolean;
}

export interface FileListResult {
  path: string;
  entries: FileEntryInfo[];
}

export interface TextFileContent {
  content: string;
  mtime: number;
  eol: '\r\n' | '\n';
}

export interface PlayersResponse {
  online: string[];
  max: number;
  warning: string | null;
  rconStatus: RconStatus;
  state: InstanceState;
}

export interface PlayerListsResponse {
  whitelist: string[];
  ops: string[];
  banned: string[];
  bannedIps: string[];
}

export interface PropertiesPayload {
  entries: Array<{ key: string; value: string; line: number }>;
  duplicates: string[];
  raw: string;
  eol: '\r\n' | '\n';
  mtime: number;
  eula: boolean;
}

export interface RconEnableResult {
  port: number;
  password: string;
}

export interface PanelSettings {
  panelName: string;
  defaultTimezone: string;
  auditRetentionDays: number;
}
```

`packages/shared/src/schemas/files.ts`：

```ts
import { z } from 'zod';

const NUL = '\0';

// `packages/shared` is bundled for the browser, so no node:path here.
function hasUnsafeSegments(value: string): boolean {
  const replaced = value.replaceAll('\\', '/');
  if (/^[A-Za-z]:/.test(replaced)) return true;
  for (const segment of replaced.split('/')) {
    if (segment === '..') return true;
  }
  return false;
}

export const filePathSchema = z
  .string()
  .max(4096)
  .optional()
  .transform((value) => value ?? '/')
  .refine((value) => !value.includes(NUL), '路径非法')
  .refine((value) => !hasUnsafeSegments(value), '路径越界');

export const saveFileSchema = z.object({
  path: z.string().min(1).max(4096).refine((value) => !value.includes(NUL), '路径非法'),
  content: z.string().max(2 * 1024 * 1024, '文件超过 2 MB'),
  expectedMtime: z.number().nonnegative(),
});

const fileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !/[\\/]/.test(value) && value !== '.' && value !== '..' && !value.includes(NUL), '文件名非法');

export const mkdirSchema = z.object({ path: z.string().min(1).max(4096) });
export const renameSchema = z.object({ path: z.string().min(1).max(4096), newName: fileNameSchema });
export const deleteFileSchema = z.object({ path: z.string().min(1).max(4096), recursive: z.boolean().default(false) });
export const unzipSchema = z.object({
  path: z.string().min(1).max(4096),
  targetDir: z.string().max(4096).optional(),
});
export const modsToggleSchema = z.object({ path: z.string().min(1).max(4096) });
export const uploadPathSchema = z.object({ path: filePathSchema });

export const propertiesSaveSchema = z.object({
  changes: z.record(z.string().min(1).max(120), z.string().max(4096)),
  expectedMtime: z.number().nonnegative(),
});

export const eulaSchema = z.object({ accept: z.literal(true) });
```

`packages/shared/src/schemas/players.ts`：

```ts
import { z } from 'zod';

const playerName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_]{1,16}$/, '玩家名不合法');
const reason = z
  .string()
  .trim()
  .max(200)
  .transform((value) => value.replace(/[\r\n]+/g, ' ').trim())
  .default('');
const message = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .transform((value) => value.replace(/[\r\n]+/g, ' ').trim());

export const playerActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('op'), player: playerName }),
  z.object({ action: z.literal('deop'), player: playerName }),
  z.object({ action: z.literal('whitelist_add'), player: playerName }),
  z.object({ action: z.literal('whitelist_remove'), player: playerName }),
  z.object({ action: z.literal('pardon'), player: playerName }),
  z.object({ action: z.literal('kick'), player: playerName, reason }),
  z.object({ action: z.literal('ban'), player: playerName, reason }),
  z.object({
    action: z.literal('gamemode'),
    player: playerName,
    mode: z.enum(['survival', 'creative', 'adventure', 'spectator']),
  }),
  z.object({ action: z.literal('broadcast'), message }),
  z.object({ action: z.literal('whitelist_on') }),
  z.object({ action: z.literal('whitelist_off') }),
]);

export type PlayerActionInput = z.infer<typeof playerActionSchema>;
```

`packages/shared/src/schemas/settings.ts`：

```ts
import { z } from 'zod';

const timeZone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, '时区无效');

export const panelSettingsSchema = z.object({
  panelName: z.string().trim().min(1).max(60),
  defaultTimezone: timeZone,
  auditRetentionDays: z.number().int().min(1).max(3650),
});

export const panelSettingsPatchSchema = panelSettingsSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个要修改的字段' });
```

`packages/shared/src/index.ts` 追加：

```ts
export * from './schemas/files';
export * from './schemas/players';
export * from './schemas/settings';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @mcpanel/shared`
Expected: 全部 PASS（原有 6 个 + 新增 3 个）。

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src packages/shared/test
git commit -m "feat(shared): add phase 2 file, player and settings contracts"
```

---

### Task 2: 文件服务核心与只读/写入路由

**Files:**
- Create: `apps/server/src/utils/fs-atomic.ts`
- Create: `apps/server/src/services/file-service.ts`
- Create: `apps/server/src/routes/files.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/test/integration/files-api.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/server/test/integration/files-api.test.ts`：

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { LoginThrottle } from '../../src/auth/guard';
import { SessionService } from '../../src/auth/session';
import { loadConfig } from '../../src/config';
import { silentLogger } from '../../src/logger';
import { FileService } from '../../src/services/file-service';
import { AuditService } from '../../src/services/audit-service';
import { InstanceService } from '../../src/services/instance-service';
import { LocalNodeDriver } from '../../src/nodes/local-driver';
import { PathSandbox } from '../../src/nodes/path-sandbox';
import { ProbeService } from '../../src/services/probe-service';
import { RconService } from '../../src/services/rcon-service';
import type { InstanceSupervisor } from '../../src/services/instance-supervisor';
import { insertInstance, insertUser } from '../helpers/factory';
import { createTestDb, type TestDb } from '../helpers/db';
import { CookieJar, TEST_ORIGIN, json } from '../helpers/http';

let ctx: TestDb | undefined;
const roots: string[] = [];

async function makeApp() {
  ctx = createTestDb();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-files-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'server.properties'), 'motd=hi\nserver-port=25565\n');
  await fs.mkdir(path.join(root, 'mods'));
  await fs.writeFile(path.join(root, 'mods', 'a.jar'), 'jar');

  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: ctx.dir });
  const sessions = new SessionService(ctx.db);
  const { token } = sessions.create(insertUser(ctx.db), null, null);
  const instanceId = insertInstance(ctx.db, { rootPath: root });
  const sandbox = new PathSandbox(ctx.dir);
  const supervisor = { getStatus: () => ({ instanceId, state: 'stopped', pid: null, startedAt: null, exitCode: null, error: null }) } as unknown as InstanceSupervisor;
  const app = await buildApp(config, ctx.db, {
    sessions,
    audit: new AuditService(ctx.db),
    loginThrottle: new LoginThrottle(),
    instances: new InstanceService(ctx.db, ctx.dir),
    supervisor,
    rcon: new RconService(),
    driver: new LocalNodeDriver(sandbox),
    probe: new ProbeService(sandbox, async () => null),
    files: new FileService(sandbox),
  }, { logger: silentLogger() });

  const jar = new CookieJar();
  const csrf = await app.inject({ method: 'GET', url: '/api/auth/csrf', headers: { cookie: `mcpanel_session=${token}` } });
  jar.absorb(csrf);
  jar.set('mcpanel_session', token);
  return {
    app,
    root,
    instanceId,
    readHeaders: { cookie: jar.header() },
    headers: { origin: TEST_ORIGIN, cookie: jar.header(), 'x-csrf-token': json<{ token: string }>(csrf).token },
  };
}

afterEach(async () => {
  ctx?.close();
  ctx = undefined;
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('files API', () => {
  it('lists directories, reads text and hides the panel temp directory', async () => {
    const { app, instanceId, readHeaders } = await makeApp();
    const list = await app.inject({
      method: 'GET',
      url: `/api/instances/${instanceId}/files?path=/mods`,
      headers: readHeaders,
    });
    expect(list.statusCode).toBe(200);
    const body = json<{ path: string; entries: Array<{ name: string; type: string; editable: boolean }> }>(list);
    expect(body.path).toBe('/mods');
    expect(body.entries).toEqual([expect.objectContaining({ name: 'a.jar', type: 'file', editable: false })]);

    const content = await app.inject({
      method: 'GET',
      url: `/api/instances/${instanceId}/files/content?path=/server.properties`,
      headers: readHeaders,
    });
    expect(content.statusCode).toBe(200);
    expect(json<{ content: string; eol: string }>(content)).toMatchObject({
      content: 'motd=hi\nserver-port=25565\n',
      eol: '\n',
    });
  });

  it('saves with an mtime guard and rejects traversal outside the instance root', async () => {
    const { app, root, instanceId, headers, readHeaders } = await makeApp();
    const before = json<{ mtime: number }>(
      await app.inject({ method: 'GET', url: `/api/instances/${instanceId}/files/content?path=/server.properties`, headers: readHeaders }),
    );

    const saved = await app.inject({
      method: 'PUT',
      url: `/api/instances/${instanceId}/files/content`,
      headers,
      payload: { path: '/server.properties', content: 'motd=new\n', expectedMtime: before.mtime },
    });
    expect(saved.statusCode).toBe(200);
    expect(await fs.readFile(path.join(root, 'server.properties'), 'utf8')).toBe('motd=new\n');

    const conflict = await app.inject({
      method: 'PUT',
      url: `/api/instances/${instanceId}/files/content`,
      headers,
      payload: { path: '/server.properties', content: 'x', expectedMtime: before.mtime },
    });
    expect(conflict.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(conflict).error.code).toBe('MTIME_CONFLICT');

    const escape = await app.inject({
      method: 'GET',
      url: `/api/instances/${instanceId}/files?path=../../`,
      headers: readHeaders,
    });
    // The request schema rejects obvious traversal first; PathSandbox is the second line of defense.
    expect(escape.statusCode).toBe(400);
    expect(json<{ error: { code: string } }>(escape).error.code).toBe('VALIDATION_ERROR');
  });

  it('creates, renames and deletes entries with a recursive guard', async () => {
    const { app, root, instanceId, headers } = await makeApp();
    const mkdir = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/files/mkdir`,
      headers,
      payload: { path: '/config' },
    });
    expect(mkdir.statusCode).toBe(201);
    expect((await fs.stat(path.join(root, 'config'))).isDirectory()).toBe(true);

    const mkdirAgain = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/files/mkdir`,
      headers,
      payload: { path: '/config' },
    });
    expect(mkdirAgain.statusCode).toBe(400);

    const rename = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/files/rename`,
      headers,
      payload: { path: '/config', newName: 'config2' },
    });
    expect(rename.statusCode).toBe(200);
    expect((await fs.stat(path.join(root, 'config2'))).isDirectory()).toBe(true);

    await fs.writeFile(path.join(root, 'config2', 'x.txt'), 'x');
    const refuse = await app.inject({
      method: 'DELETE',
      url: `/api/instances/${instanceId}/files`,
      headers,
      payload: { path: '/config2' },
    });
    expect(refuse.statusCode).toBe(400);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/instances/${instanceId}/files`,
      headers,
      payload: { path: '/config2', recursive: true },
    });
    expect(remove.statusCode).toBe(204);
    await expect(fs.stat(path.join(root, 'config2'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects deleting the instance root and symbol links', async () => {
    const { app, root, instanceId, headers } = await makeApp();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-outside-'));
    roots.push(outside);
    await fs.symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');

    const rootDelete = await app.inject({
      method: 'DELETE',
      url: `/api/instances/${instanceId}/files`,
      headers,
      payload: { path: '/', recursive: true },
    });
    expect(rootDelete.statusCode).toBe(400);

    const linkedDelete = await app.inject({
      method: 'DELETE',
      url: `/api/instances/${instanceId}/files`,
      headers,
      payload: { path: '/link', recursive: true },
    });
    expect(linkedDelete.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(linkedDelete).error.code).toBe('SYMLINK_NOT_ALLOWED');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/server -- test/integration/files-api.test.ts`
Expected: FAIL，`file-service` 与路由不存在，`files` 不在 `AppServices` 里。

- [ ] **Step 3: 实现原子写、FileService 与路由**

`apps/server/src/utils/fs-atomic.ts`：

```ts
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function writeFileAtomic(file: string, content: string): Promise<void> {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await fs.writeFile(temp, content, 'utf8');
  try {
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}
```

`apps/server/src/services/file-service.ts`：

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileEntryInfo, FileListResult, TextFileContent } from '@mcpanel/shared';
import type { PathSandbox } from '../nodes/path-sandbox';
import { AppError } from '../utils/errors';
import { writeFileAtomic } from '../utils/fs-atomic';

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export class FileService {
  constructor(private readonly sandbox: PathSandbox) {}

  async list(root: string, relPath: string): Promise<FileListResult> {
    const dir = await this.sandbox.resolve(root, relPath);
    const dirStat = await fs.lstat(dir);
    if (dirStat.isSymbolicLink()) throw new AppError('SYMLINK_NOT_ALLOWED', '不允许访问符号链接');
    if (!dirStat.isDirectory()) throw new AppError('VALIDATION_ERROR', '目标不是目录');
    const entries: FileEntryInfo[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.mcpanel-tmp') continue;
      const absolute = path.join(dir, entry.name);
      const stat = await fs.lstat(absolute);
      const isFile = stat.isFile();
      entries.push({
        name: entry.name,
        type: stat.isDirectory() ? 'directory' : 'file',
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        symlink: stat.isSymbolicLink(),
        editable: isFile && !stat.isSymbolicLink() && stat.size <= MAX_TEXT_BYTES,
      });
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
    const normalized = this.sandbox.normalizeRelative(relPath);
    return { path: normalized ? `/${normalized}` : '/', entries };
  }

  async read(root: string, relPath: string): Promise<TextFileContent> {
    const file = await this.sandbox.resolve(root, relPath);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) throw new AppError('SYMLINK_NOT_ALLOWED', '不允许读取符号链接');
    if (!stat.isFile()) throw new AppError('UNSUPPORTED_FILE', '目标不是普通文件');
    if (stat.size > MAX_TEXT_BYTES) throw new AppError('FILE_TOO_LARGE', '文件超过 2 MB');
    const raw = await fs.readFile(file);
    if (raw.includes(0)) throw new AppError('UNSUPPORTED_FILE', '这是二进制文件');
    const content = raw.toString('utf8');
    return { content, mtime: stat.mtimeMs, eol: content.includes('\r\n') ? '\r\n' : '\n' };
  }

  async save(root: string, relPath: string, content: string, expectedMtime: number): Promise<{ mtime: number }> {
    const file = await this.sandbox.resolve(root, relPath);
    const stat = await fs.lstat(file).catch((error: unknown) => {
      if (isEnoent(error)) throw new AppError('NOT_FOUND', '文件不存在');
      throw error;
    });
    if (stat.isSymbolicLink()) throw new AppError('SYMLINK_NOT_ALLOWED', '不允许写入符号链接');
    if (!stat.isFile()) throw new AppError('UNSUPPORTED_FILE', '目标不是普通文件');
    if (Math.abs(stat.mtimeMs - expectedMtime) > 0.5) {
      throw new AppError('MTIME_CONFLICT', '文件已被外部修改');
    }
    await writeFileAtomic(file, content);
    return { mtime: (await fs.stat(file)).mtimeMs };
  }

  async mkdir(root: string, relPath: string): Promise<void> {
    const normalized = this.sandbox.normalizeRelative(relPath);
    if (!normalized) throw new AppError('VALIDATION_ERROR', '目录名不能为空');
    const target = await this.sandbox.resolve(root, normalized);
    try {
      await fs.mkdir(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new AppError('VALIDATION_ERROR', '同名文件或目录已存在');
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AppError('VALIDATION_ERROR', '上级目录不存在');
      }
      throw error;
    }
  }

  async rename(root: string, relPath: string, newName: string): Promise<{ path: string }> {
    const normalized = this.sandbox.normalizeRelative(relPath);
    if (!normalized) throw new AppError('VALIDATION_ERROR', '不能重命名实例根目录');
    const parent = path.posix.dirname(normalized);
    const nextRel = parent === '.' ? newName : `${parent}/${newName}`;
    const source = await this.sandbox.resolve(root, normalized);
    const target = await this.sandbox.resolve(root, nextRel);
    const exists = await fs.lstat(target).then(
      () => true,
      (error: unknown) => {
        if (isEnoent(error)) return false;
        throw error;
      },
    );
    if (exists) throw new AppError('VALIDATION_ERROR', '同名文件或目录已存在');
    await fs.rename(source, target);
    return { path: `/${nextRel}` };
  }

  async remove(root: string, relPath: string, recursive: boolean): Promise<void> {
    const normalized = this.sandbox.normalizeRelative(relPath);
    if (!normalized) throw new AppError('VALIDATION_ERROR', '不能删除实例根目录');
    const target = await this.sandbox.resolve(root, normalized);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new AppError('SYMLINK_NOT_ALLOWED', '不允许删除符号链接');
    if (stat.isDirectory() && !recursive) throw new AppError('VALIDATION_ERROR', '删除目录需要递归确认');
    await fs.rm(target, { recursive, force: false });
  }

  async download(root: string, relPath: string): Promise<{ file: string; name: string; size: number }> {
    const file = await this.sandbox.resolve(root, relPath);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) throw new AppError('SYMLINK_NOT_ALLOWED', '不允许下载符号链接');
    if (!stat.isFile()) throw new AppError('UNSUPPORTED_FILE', '只能下载文件');
    return { file, name: path.basename(file), size: stat.size };
  }

  /** Resolves an existing directory, used by upload/unzip targets. */
  async resolveDirectory(root: string, relPath: string): Promise<{ dir: string; rel: string }> {
    const normalized = this.sandbox.normalizeRelative(relPath);
    const dir = await this.sandbox.resolve(root, normalized);
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink()) throw new AppError('SYMLINK_NOT_ALLOWED', '不允许访问符号链接');
    if (!stat.isDirectory()) throw new AppError('VALIDATION_ERROR', '目标不是目录');
    return { dir, rel: normalized };
  }
}
```

`apps/server/src/routes/files.ts`：

```ts
import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  deleteFileSchema,
  filePathSchema,
  mkdirSchema,
  renameSchema,
  saveFileSchema,
  type FileListResult,
} from '@mcpanel/shared';
import { createGuards } from '../auth/guard';
import type { SessionService } from '../auth/session';
import type { AppConfig } from '../config';
import type { InstanceService } from '../services/instance-service';
import type { AuditService } from '../services/audit-service';
import type { FileService } from '../services/file-service';

export interface FileRouteDeps {
  sessions: SessionService;
  audit: AuditService;
  instances: InstanceService;
  files: FileService;
  config: AppConfig;
}

export function registerFileRoutes(app: FastifyInstance, deps: FileRouteDeps): void {
  const { sessions, audit, instances, files, config } = deps;
  const { requireAuth, requireOrigin } = createGuards(sessions);
  const read = { preHandler: [requireAuth] };
  const write = { preHandler: [requireOrigin, requireAuth, app.csrfProtection] };

  const rootOf = (id: string): string => instances.get(id).rootPath;

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/instances/:id/files',
    read,
    async (request): Promise<FileListResult> => {
      const { path: relPath } = request.query;
      return files.list(rootOf(request.params.id), filePathSchema.parse(relPath));
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/instances/:id/files/content',
    read,
    async (request) => {
      const relPath = filePathSchema.parse(request.query.path);
      return files.read(rootOf(request.params.id), relPath);
    },
  );

  app.put<{ Params: { id: string } }>('/api/instances/:id/files/content', write, async (request) => {
    const input = saveFileSchema.parse(request.body);
    const saved = await files.save(rootOf(request.params.id), input.path, input.content, input.expectedMtime);
    audit.record({
      userId: request.user?.id,
      action: 'file.save',
      targetType: 'instance',
      targetId: request.params.id,
      detail: { path: input.path, bytes: input.content.length },
      ip: request.ip,
    });
    return saved;
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/instances/:id/files/download',
    read,
    async (request, reply) => {
      const relPath = filePathSchema.parse(request.query.path);
      const target = await files.download(rootOf(request.params.id), relPath);
      reply.type('application/octet-stream');
      reply.header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(target.name)}"; filename*=UTF-8''${encodeURIComponent(target.name)}`,
      );
      return reply.send(createReadStream(target.file));
    },
  );

  app.post<{ Params: { id: string } }>('/api/instances/:id/files/mkdir', write, async (request, reply) => {
    const input = mkdirSchema.parse(request.body);
    await files.mkdir(rootOf(request.params.id), input.path);
    audit.record({
      userId: request.user?.id,
      action: 'file.mkdir',
      targetType: 'instance',
      targetId: request.params.id,
      detail: { path: input.path },
      ip: request.ip,
    });
    return reply.status(201).send({ ok: true });
  });

  app.post<{ Params: { id: string } }>('/api/instances/:id/files/rename', write, async (request) => {
    const input = renameSchema.parse(request.body);
    const result = await files.rename(rootOf(request.params.id), input.path, input.newName);
    audit.record({
      userId: request.user?.id,
      action: 'file.rename',
      targetType: 'instance',
      targetId: request.params.id,
      detail: { path: input.path, newName: input.newName },
      ip: request.ip,
    });
    return result;
  });

  app.delete<{ Params: { id: string } }>('/api/instances/:id/files', write, async (request, reply) => {
    const input = deleteFileSchema.parse(request.body);
    await files.remove(rootOf(request.params.id), input.path, input.recursive);
    audit.record({
      userId: request.user?.id,
      action: 'file.delete',
      targetType: 'instance',
      targetId: request.params.id,
      detail: { path: input.path, recursive: input.recursive },
      ip: request.ip,
    });
    return reply.status(204).send();
  });
}
```

- [ ] **Step 4: 接入 app 与启动入口**

`apps/server/src/app.ts`：
1. 顶部 import：

```ts
import type { FileService } from './services/file-service';
import { registerFileRoutes } from './routes/files';
```

2. `AppServices` 增加可选字段（放在 `probe` 之后）：

```ts
  files?: FileService;
```

3. 在实例路由注册块之后追加：

```ts
  if (services.instances && services.files) {
    registerFileRoutes(app, {
      sessions: services.sessions,
      audit: services.audit,
      instances: services.instances,
      files: services.files,
      config,
    });
  }
```

`apps/server/src/index.ts`：import `FileService`，在 `sandbox` 创建后追加 `const files = new FileService(sandbox);`，并在 `buildApp` 的 services 字面量里加入 `files`。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -w @mcpanel/server -- test/integration/files-api.test.ts`
Expected: 4 个测试 PASS。

- [ ] **Step 6: 全量校验并提交**

Run: `npm run typecheck && npm test && npm run lint`
Expected: 全绿。

```bash
git add apps/server/src apps/server/test
git commit -m "feat(server): add sandboxed file listing, editing and deletion"
```

---

### Task 3: 上传、解压与模组启停

**Files:**
- Modify: `apps/server/package.json`（新增 `@fastify/multipart`、`yauzl`；devDependencies 新增 `@types/yauzl`）
- Modify: `apps/server/src/services/file-service.ts`
- Modify: `apps/server/src/routes/files.ts`
- Modify: `apps/server/src/app.ts`（注册 multipart）
- Test: `apps/server/test/integration/files-upload.test.ts`

- [ ] **Step 1: 安装依赖**

```bash
npm install @fastify/multipart yauzl -w @mcpanel/server
npm install -D @types/yauzl -w @mcpanel/server
```

`yauzl` 是流式解压，不把 zip 全量读进内存；`@fastify/multipart` 提供流式上传。

- [ ] **Step 2: 写失败测试**

`apps/server/test/integration/files-upload.test.ts`：

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { LoginThrottle } from '../../src/auth/guard';
import { SessionService } from '../../src/auth/session';
import { loadConfig } from '../../src/config';
import { silentLogger } from '../../src/logger';
import { AuditService } from '../../src/services/audit-service';
import { FileService } from '../../src/services/file-service';
import { InstanceService } from '../../src/services/instance-service';
import { LocalNodeDriver } from '../../src/nodes/local-driver';
import { PathSandbox } from '../../src/nodes/path-sandbox';
import { ProbeService } from '../../src/services/probe-service';
import { RconService } from '../../src/services/rcon-service';
import type { InstanceSupervisor } from '../../src/services/instance-supervisor';
import { insertInstance, insertUser } from '../helpers/factory';
import { createTestDb, type TestDb } from '../helpers/db';
import { CookieJar, TEST_ORIGIN, json } from '../helpers/http';

let ctx: TestDb | undefined;
const roots: string[] = [];

async function makeApp(maxUploadMb = 1) {
  ctx = createTestDb();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-upload-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'mods'));
  await fs.writeFile(path.join(root, 'mods', 'old.jar'), 'jar');

  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: ctx.dir, MAX_UPLOAD_MB: String(maxUploadMb) });
  const sessions = new SessionService(ctx.db);
  const { token } = sessions.create(insertUser(ctx.db), null, null);
  const instanceId = insertInstance(ctx.db, { rootPath: root });
  const sandbox = new PathSandbox(ctx.dir);
  const supervisor = { getStatus: () => ({ instanceId, state: 'stopped', pid: null, startedAt: null, exitCode: null, error: null }) } as unknown as InstanceSupervisor;
  const app = await buildApp(config, ctx.db, {
    sessions,
    audit: new AuditService(ctx.db),
    loginThrottle: new LoginThrottle(),
    instances: new InstanceService(ctx.db, ctx.dir),
    supervisor,
    rcon: new RconService(),
    driver: new LocalNodeDriver(sandbox),
    probe: new ProbeService(sandbox, async () => null),
    files: new FileService(sandbox),
  }, { logger: silentLogger() });

  const jar = new CookieJar();
  const csrf = await app.inject({ method: 'GET', url: '/api/auth/csrf', headers: { cookie: `mcpanel_session=${token}` } });
  jar.absorb(csrf);
  jar.set('mcpanel_session', token);
  return {
    app,
    root,
    instanceId,
    token: json<{ token: string }>(csrf).token,
    readHeaders: { cookie: jar.header() },
  };
}

async function upload(
  app: Awaited<ReturnType<typeof makeApp>>['app'],
  instanceId: string,
  token: string,
  targetPath: string,
  filename: string,
  content: Buffer,
) {
  const boundary = '----mcpanel-test-boundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n${targetPath}\r\n`),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: 'POST',
    url: `/api/instances/${instanceId}/files/upload`,
    headers: {
      origin: TEST_ORIGIN,
      cookie: `mcpanel_session=${token}`,
      'x-csrf-token': token,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: body,
  });
}

afterEach(async () => {
  ctx?.close();
  ctx = undefined;
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('file upload, unzip and mods', () => {
  it('streams an upload into the requested directory', async () => {
    const { app, root, instanceId, token } = await makeApp();
    const res = await upload(app, instanceId, token, '/mods', 'new.jar', Buffer.from('jar-bytes'));
    expect(res.statusCode).toBe(201);
    expect(await fs.readFile(path.join(root, 'mods', 'new.jar'), 'utf8')).toBe('jar-bytes');
  });

  it('rejects an upload larger than MAX_UPLOAD_MB', async () => {
    const { app, root, instanceId, token } = await makeApp(1);
    const res = await upload(app, instanceId, token, '/mods', 'big.jar', Buffer.alloc(2 * 1024 * 1024, 1));
    expect(res.statusCode).toBe(413);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('FILE_TOO_LARGE');
    await expect(fs.stat(path.join(root, 'mods', 'big.jar'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('toggles jar and jar.disabled only inside mods/', async () => {
    const { app, root, instanceId, token } = await makeApp();
    const headers = { origin: TEST_ORIGIN, cookie: `mcpanel_session=${token}`, 'x-csrf-token': token };
    const disable = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/files/mods/toggle`,
      headers,
      payload: { path: '/mods/old.jar' },
    });
    expect(disable.statusCode).toBe(200);
    expect((await fs.stat(path.join(root, 'mods', 'old.jar.disabled'))).isFile()).toBe(true);

    const enable = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/files/mods/toggle`,
      headers,
      payload: { path: '/mods/old.jar.disabled' },
    });
    expect(enable.statusCode).toBe(200);
    expect((await fs.stat(path.join(root, 'mods', 'old.jar'))).isFile()).toBe(true);

    await fs.writeFile(path.join(root, 'ops.json'), '[]');
    const outside = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/files/mods/toggle`,
      headers,
      payload: { path: '/ops.json' },
    });
    expect(outside.statusCode).toBe(400);
  });
});
```

> 解压测试需要一个真实 zip。用 Node 生成：见 Step 3 末尾的 `makeZip` 辅助函数与第四个测试：

```ts
  it('extracts a zip and rejects zip-slip entries', async () => {
    const { app, root, instanceId, token } = await makeApp();
    await fs.writeFile(path.join(root, 'pack.zip'), makeZip({ 'config/a.txt': 'hello' }));
    const headers = { origin: TEST_ORIGIN, cookie: `mcpanel_session=${token}`, 'x-csrf-token': token };

    const ok = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/files/unzip`,
      headers,
      payload: { path: '/pack.zip', targetDir: '/unpacked' },
    });
    expect(ok.statusCode).toBe(200);
    expect(await fs.readFile(path.join(root, 'unpacked', 'config', 'a.txt'), 'utf8')).toBe('hello');

    await fs.writeFile(path.join(root, 'evil.zip'), makeZip({ '../escape.txt': 'x' }));
    const evil = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/files/unzip`,
      headers,
      payload: { path: '/evil.zip', targetDir: '/unpacked' },
    });
    expect(evil.statusCode).toBe(400);
    expect(json<{ error: { code: string } }>(evil).error.code).toBe('ZIP_INVALID');
    await expect(fs.stat(path.join(root, '..', 'escape.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
```

测试文件顶部再加：

```ts
import { crc32, deflateRawSync } from 'node:zlib';

function makeZip(files: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = deflateRawSync(Buffer.from(text, 'utf8'));
    const crc = crc32(Buffer.from(text, 'utf8')) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(Buffer.byteLength(text), 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(Buffer.byteLength(text), 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralSize = central.reduce((total, chunk) => total + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}
```

- [ ] **Step 3: 实现上传、解压与模组启停**

`apps/server/src/app.ts` 注册 multipart（在 `app.register(cookie)` 之前）：

```ts
import multipart from '@fastify/multipart';
...
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1, fields: 4 },
  });
```

同时在 `app.setErrorHandler` 的 `FST_ERR_CTP` 分支后追加（该插件在流超限时会抛出此错误码）：

```ts
    if (code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.status(413).send({ error: { code: 'FILE_TOO_LARGE', message: '上传超过大小限制' } });
    }
```

`FileService` 顶部补充 import（`fs` 来自 `node:fs/promises`，写流来自 `node:fs`）：

```ts
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';
```

`FileService` 追加：

```ts
  async upload(root: string, relPath: string, filename: string, stream: Readable, limitBytes: number): Promise<{ path: string }> {
    const { dir, rel } = await this.resolveDirectory(root, relPath);
    const safeName = filename.replace(/[\\/]/g, '').trim();
    if (!safeName || safeName === '.' || safeName === '..' || safeName.includes('\0')) {
      throw new AppError('VALIDATION_ERROR', '文件名非法');
    }
    const nextRel = rel ? `${rel}/${safeName}` : safeName;
    const target = await this.sandbox.resolve(root, nextRel);
    const targetStat = await fs.lstat(target).catch((error: unknown) => {
      if (isEnoent(error)) return null;
      throw error;
    });
    if (targetStat?.isDirectory()) throw new AppError('VALIDATION_ERROR', '同名目录已存在');

    const tempDir = path.join(root, '.mcpanel-tmp');
    await fs.mkdir(tempDir, { recursive: true });
    const temp = path.join(tempDir, `upload-${randomUUID()}.tmp`);
    let written = 0;
    try {
      await pipeline(
        stream,
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            written += chunk.length;
            if (written > limitBytes) throw new AppError('FILE_TOO_LARGE', `上传超过 ${Math.floor(limitBytes / 1024 / 1024)} MB`);
            yield chunk;
          }
        },
        createWriteStream(temp),
      );
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
    return { path: `/${nextRel}` };
  }
```

补充 import：

```ts
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
```

解压与模组启停：

```ts
const MAX_ZIP_ENTRIES = 100_000;
const MAX_ZIP_BYTES = 10 * 1024 * 1024 * 1024;

function isUnsafeEntry(name: string): boolean {
  const normalized = name.replaceAll('\\', '/');
  return (
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..') ||
    normalized.includes('\0')
  );
}

  async unzip(root: string, relPath: string, targetDir?: string): Promise<{ entries: number }> {
    const archivePath = await this.sandbox.resolve(root, relPath);
    const archiveStat = await fs.lstat(archivePath);
    if (!archiveStat.isFile()) throw new AppError('ZIP_INVALID', '目标不是文件');
    const destinationRel = targetDir
      ? this.sandbox.normalizeRelative(targetDir)
      : path.posix.dirname(this.sandbox.normalizeRelative(relPath));
    const destination = await this.sandbox.resolve(root, destinationRel === '.' ? '' : destinationRel);
    await fs.mkdir(destination, { recursive: true });

    const entries = await new Promise<number>((resolve, reject) => {
      yauzl.open(archivePath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
        if (openError || !zip) {
          reject(new AppError('ZIP_INVALID', '压缩包无法打开'));
          return;
        }
        let count = 0;
        let totalBytes = 0;
        const fail = (error: unknown) => {
          zip.close();
          reject(error instanceof AppError ? error : new AppError('ZIP_INVALID', '解压失败'));
        };
        zip.on('error', fail);
        zip.readEntry();
        zip.on('entry', (entry: yauzl.Entry) => {
          count += 1;
          totalBytes += entry.uncompressedSize;
          if (count > MAX_ZIP_ENTRIES) return fail(new AppError('ZIP_INVALID', '压缩包条目过多'));
          if (totalBytes > MAX_ZIP_BYTES) return fail(new AppError('ZIP_INVALID', '解压后体积超过 10 GB'));
          if (isUnsafeEntry(entry.fileName)) return fail(new AppError('ZIP_INVALID', '压缩包包含越界路径'));
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (mode === 0o120000) return fail(new AppError('ZIP_INVALID', '压缩包包含符号链接条目'));

          if (entry.fileName.endsWith('/')) {
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (streamError, readStream) => {
            if (streamError || !readStream) return fail(streamError ?? new Error('无法读取条目'));
            const outRel = destinationRel === '.' || destinationRel === ''
              ? entry.fileName
              : `${destinationRel}/${entry.fileName}`;
            void this.sandbox
              .resolve(root, outRel)
              .then(async (outFile) => {
                await fs.mkdir(path.dirname(outFile), { recursive: true });
                await pipeline(readStream, createWriteStream(outFile));
                zip.readEntry();
              })
              .catch(fail);
          });
        });
        zip.on('end', () => resolve(count));
      });
    });
    return { entries };
  }

  async toggleMod(root: string, relPath: string): Promise<{ path: string }> {
    const normalized = this.sandbox.normalizeRelative(relPath);
    if (!normalized.startsWith('mods/')) throw new AppError('VALIDATION_ERROR', '只有 mods/ 目录下的模组可以启停');
    let nextRel: string;
    if (normalized.endsWith('.jar')) nextRel = `${normalized}.disabled`;
    else if (normalized.endsWith('.jar.disabled')) nextRel = normalized.slice(0, -'.disabled'.length);
    else throw new AppError('VALIDATION_ERROR', '只支持 .jar 与 .jar.disabled 文件');

    const source = await this.sandbox.resolve(root, normalized);
    const target = await this.sandbox.resolve(root, nextRel);
    const stat = await fs.lstat(source);
    if (!stat.isFile()) throw new AppError('VALIDATION_ERROR', '目标不是文件');
    const exists = await fs.lstat(target).then(
      () => true,
      (error: unknown) => {
        if (isEnoent(error)) return false;
        throw error;
      },
    );
    if (exists) throw new AppError('VALIDATION_ERROR', '目标文件已存在');
    await fs.rename(source, target);
    return { path: `/${nextRel}` };
  }
```

`routes/files.ts` 追加（放在 delete 路由之前）：

```ts
  app.post<{ Params: { id: string } }>('/api/instances/:id/files/upload', write, async (request, reply) => {
    const row = instances.get(request.params.id);
    const part = await request.file();
    if (!part) throw new AppError('VALIDATION_ERROR', '缺少上传文件');
    const field = part.fields['path'];
    const rawPath = field && !Array.isArray(field) && 'value' in field ? String(field.value) : '/';
    const target = await files.upload(
      row.rootPath,
      filePathSchema.parse(rawPath),
      part.filename,
      part.file,
      config.maxUploadMb * 1024 * 1024,
    );
    // The multipart parser truncates the stream at the limit instead of rejecting the request.
    if (part.file.truncated) {
      await files.remove(row.rootPath, target.path, false).catch(() => undefined);
      throw new AppError('FILE_TOO_LARGE', '上传超过大小限制');
    }
    audit.record({
      userId: request.user?.id,
      action: 'file.upload',
      targetType: 'instance',
      targetId: row.id,
      detail: { path: target.path },
      ip: request.ip,
    });
    return reply.status(201).send(target);
  });
```

> 上传路由需要 `config`：把它加进 `FileRouteDeps` 并在 `app.ts` 注册时传入 `config`。同时 import `AppError`。

```ts
  app.post<{ Params: { id: string } }>('/api/instances/:id/files/unzip', write, async (request) => {
    const input = unzipSchema.parse(request.body);
    const result = await files.unzip(rootOf(request.params.id), input.path, input.targetDir);
    audit.record({
      userId: request.user?.id,
      action: 'file.unzip',
      targetType: 'instance',
      targetId: request.params.id,
      detail: { path: input.path, targetDir: input.targetDir ?? null, entries: result.entries },
      ip: request.ip,
    });
    return result;
  });

  app.post<{ Params: { id: string } }>('/api/instances/:id/files/mods/toggle', write, async (request) => {
    const input = modsToggleSchema.parse(request.body);
    const result = await files.toggleMod(rootOf(request.params.id), input.path);
    audit.record({
      userId: request.user?.id,
      action: 'file.mod_toggle',
      targetType: 'instance',
      targetId: request.params.id,
      detail: { path: input.path, next: result.path },
      ip: request.ip,
    });
    return result;
  });
```

补充 import：`unzipSchema`、`modsToggleSchema`、`AppError`、`type AppConfig`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @mcpanel/server -- test/integration/files-upload.test.ts`
Expected: 4 个测试 PASS；超限上传返回 413 且不留临时文件。

- [ ] **Step 5: 全量校验并提交**

```bash
npm run typecheck && npm test && npm run lint
git add apps/server/package.json package-lock.json apps/server/src apps/server/test
git commit -m "feat(server): add streaming upload, safe unzip and mods toggle"
```

---

### Task 4: `server.properties` 补丁与配置路由、EULA

**Files:**
- Create: `apps/server/src/services/properties-patch.ts`
- Create: `apps/server/src/routes/config.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/test/integration/config-api.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/server/test/integration/config-api.test.ts`：

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { LoginThrottle } from '../../src/auth/guard';
import { SessionService } from '../../src/auth/session';
import { loadConfig } from '../../src/config';
import { silentLogger } from '../../src/logger';
import { AuditService } from '../../src/services/audit-service';
import { FileService } from '../../src/services/file-service';
import { InstanceService } from '../../src/services/instance-service';
import { LocalNodeDriver } from '../../src/nodes/local-driver';
import { PathSandbox } from '../../src/nodes/path-sandbox';
import { ProbeService } from '../../src/services/probe-service';
import { RconService } from '../../src/services/rcon-service';
import type { InstanceSupervisor } from '../../src/services/instance-supervisor';
import { insertInstance, insertUser } from '../helpers/factory';
import { createTestDb, type TestDb } from '../helpers/db';
import { CookieJar, TEST_ORIGIN, json } from '../helpers/http';

let ctx: TestDb | undefined;
const roots: string[] = [];

const PROPS = '# Minecraft server properties\r\nmotd=Old\r\nserver-port=25565\r\nmotd=Duplicate\r\n\r\nview-distance=10\r\n';

async function makeApp() {
  ctx = createTestDb();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-config-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'server.properties'), PROPS);
  await fs.writeFile(path.join(root, 'eula.txt'), '#By changing the setting below to TRUE you are indicating your agreement\n_eula=false\n');

  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: ctx.dir });
  const sessions = new SessionService(ctx.db);
  const { token } = sessions.create(insertUser(ctx.db), null, null);
  const instanceId = insertInstance(ctx.db, { rootPath: root });
  const sandbox = new PathSandbox(ctx.dir);
  const supervisor = { getStatus: () => ({ instanceId, state: 'stopped', pid: null, startedAt: null, exitCode: null, error: null }) } as unknown as InstanceSupervisor;
  const app = await buildApp(config, ctx.db, {
    sessions,
    audit: new AuditService(ctx.db),
    loginThrottle: new LoginThrottle(),
    instances: new InstanceService(ctx.db, ctx.dir),
    supervisor,
    rcon: new RconService(),
    driver: new LocalNodeDriver(sandbox),
    probe: new ProbeService(sandbox, async () => null),
    files: new FileService(sandbox),
  }, { logger: silentLogger() });

  const jar = new CookieJar();
  const csrf = await app.inject({ method: 'GET', url: '/api/auth/csrf', headers: { cookie: `mcpanel_session=${token}` } });
  jar.absorb(csrf);
  jar.set('mcpanel_session', token);
  return {
    app,
    root,
    instanceId,
    headers: { origin: TEST_ORIGIN, cookie: jar.header(), 'x-csrf-token': json<{ token: string }>(csrf).token },
    readHeaders: { cookie: jar.header() },
  };
}

afterEach(async () => {
  ctx?.close();
  ctx = undefined;
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('config API', () => {
  it('reports entries, duplicates and the original EOL', async () => {
    const { app, instanceId, readHeaders } = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/instances/${instanceId}/config/properties`,
      headers: readHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = json<{ duplicates: string[]; eol: string; raw: string; entries: Array<{ key: string; value: string }> }>(res);
    expect(body.duplicates).toEqual(['motd']);
    expect(body.eol).toBe('\r\n');
    expect(body.entries.filter((entry) => entry.key === 'motd').map((entry) => entry.value)).toEqual(['Old', 'Duplicate']);
  });

  it('patches every duplicate, keeps comments and order, and guards mtime', async () => {
    const { app, root, instanceId, headers, readHeaders } = await makeApp();
    const before = json<{ mtime: number }>(
      await app.inject({ method: 'GET', url: `/api/instances/${instanceId}/config/properties`, headers: readHeaders }),
    );
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/instances/${instanceId}/config/properties`,
      headers,
      payload: { changes: { motd: '新公告', 'max-players': '20' }, expectedMtime: before.mtime },
    });
    expect(saved.statusCode).toBe(200);

    const raw = await fs.readFile(path.join(root, 'server.properties'), 'utf8');
    expect(raw.startsWith('# Minecraft server properties\r\n')).toBe(true);
    expect(raw).toContain('motd=新公告\r\nserver-port=25565\r\nmotd=新公告\r\n');
    expect(raw.endsWith('max-players=20\r\n')).toBe(true);

    const conflict = await app.inject({
      method: 'PUT',
      url: `/api/instances/${instanceId}/config/properties`,
      headers,
      payload: { changes: { motd: 'x' }, expectedMtime: before.mtime },
    });
    expect(conflict.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(conflict).error.code).toBe('MTIME_CONFLICT');
  });

  it('rejects invalid values before touching the file', async () => {
    const { app, root, instanceId, headers, readHeaders } = await makeApp();
    const before = json<{ mtime: number }>(
      await app.inject({ method: 'GET', url: `/api/instances/${instanceId}/config/properties`, headers: readHeaders }),
    );
    const res = await app.inject({
      method: 'PUT',
      url: `/api/instances/${instanceId}/config/properties`,
      headers,
      payload: { changes: { 'server-port': '70000' }, expectedMtime: before.mtime },
    });
    expect(res.statusCode).toBe(400);
    expect(await fs.readFile(path.join(root, 'server.properties'), 'utf8')).toBe(PROPS);
  });

  it('accepts the EULA explicitly and audits it', async () => {
    const { app, root, instanceId, headers } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/config/eula`,
      headers,
      payload: { accept: true },
    });
    expect(res.statusCode).toBe(200);
    const raw = await fs.readFile(path.join(root, 'eula.txt'), 'utf8');
    expect(raw).toBe('#By changing the setting below to TRUE you are indicating your agreement\n_eula=true\n');
    const auditRow = ctx!.db.prepare(`SELECT action FROM audit_logs WHERE action = 'instance.eula_accept'`).get();
    expect(auditRow).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/server -- test/integration/config-api.test.ts`
Expected: FAIL，路由不存在（404）。

- [ ] **Step 3: 实现纯函数补丁**

`apps/server/src/services/properties-patch.ts`：

```ts
import { AppError } from '../utils/errors';

const INT_RULES: Record<string, [number, number]> = {
  'server-port': [1, 65535],
  'rcon.port': [1, 65535],
  'query.port': [1, 65535],
  'max-players': [1, 10000],
  'view-distance': [2, 32],
  'simulation-distance': [2, 32],
  'spawn-protection': [0, 1000],
  'op-permission-level': [1, 4],
  'entity-broadcast-range-percentage': [10, 1000],
  'max-tick-time': [-1, 600000],
};

const BOOL_KEYS = new Set([
  'online-mode',
  'white-list',
  'enforce-whitelist',
  'hardcore',
  'pvp',
  'allow-flight',
  'force-gamemode',
  'enable-rcon',
  'enable-query',
  'allow-nether',
  'enable-command-block',
]);

const ENUM_RULES: Record<string, readonly string[]> = {
  gamemode: ['survival', 'creative', 'adventure', 'spectator'],
  difficulty: ['peaceful', 'easy', 'normal', 'hard'],
};

export function validatePropertyChanges(changes: Record<string, string>): void {
  for (const [key, value] of Object.entries(changes)) {
    if (BOOL_KEYS.has(key) && value !== 'true' && value !== 'false') {
      throw new AppError('VALIDATION_ERROR', `${key} 只能是 true 或 false`, { field: key });
    }
    const range = INT_RULES[key];
    if (range) {
      const parsed = Number(value);
      if (!/^-?\d+$/.test(value) || !Number.isInteger(parsed) || parsed < range[0] || parsed > range[1]) {
        throw new AppError('VALIDATION_ERROR', `${key} 必须在 ${range[0]} 到 ${range[1]} 之间`, { field: key });
      }
    }
    const allowed = ENUM_RULES[key];
    if (allowed && !allowed.includes(value)) {
      throw new AppError('VALIDATION_ERROR', `${key} 取值不合法`, { field: key });
    }
    if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) {
      throw new AppError('VALIDATION_ERROR', '键值不能包含换行', { field: key });
    }
  }
}

export function patchProperties(raw: string, changes: Record<string, string>): string {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = raw.endsWith('\n');
  const lines = raw.split(/\r?\n/);
  if (hadTrailingNewline) lines.pop();

  const remaining = new Map(Object.entries(changes));
  const next = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return line;
    const separator = trimmed.indexOf('=');
    if (separator < 0) return line;
    const key = trimmed.slice(0, separator).trim();
    if (!remaining.has(key)) return line;
    const value = remaining.get(key) ?? '';
    remaining.delete(key);
    return `${key}=${value}`;
  });

  for (const [key, value] of remaining) next.push(`${key}=${value}`);
  const body = next.join(eol);
  return hadTrailingNewline || remaining.size > 0 ? `${body}${eol}` : body;
}

export function patchEula(raw: string | null): string {
  if (raw === null) return 'eula=true\n';
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = raw.endsWith('\n');
  const lines = raw.split(/\r?\n/);
  if (hadTrailingNewline) lines.pop();
  let found = false;
  const next = lines.map((line) => {
    const trimmed = line.trim();
    const separator = trimmed.indexOf('=');
    if (separator < 0) return line;
    const key = trimmed.slice(0, separator).trim();
    if (key !== 'eula' && key !== '_eula') return line;
    found = true;
    return `${key}=true`;
  });
  if (!found) next.push('eula=true');
  return `${next.join(eol)}${eol}`;
}
```

- [ ] **Step 4: 实现配置路由**

`apps/server/src/routes/config.ts`：

```ts
import type { FastifyInstance } from 'fastify';
import { eulaSchema, propertiesSaveSchema, type PropertiesPayload } from '@mcpanel/shared';
import { createGuards } from '../auth/guard';
import type { SessionService } from '../auth/session';
import type { PathSandbox } from '../nodes/path-sandbox';
import type { AuditService } from '../services/audit-service';
import type { InstanceService } from '../services/instance-service';
import type { RconService } from '../services/rcon-service';
import { loadServerProperties } from '../services/properties-service';
import { patchEula, patchProperties, validatePropertyChanges } from '../services/properties-patch';
import { AppError } from '../utils/errors';
import { writeFileAtomic } from '../utils/fs-atomic';

export interface ConfigRouteDeps {
  sessions: SessionService;
  audit: AuditService;
  instances: InstanceService;
  rcon: RconService;
  sandbox: PathSandbox;
}

async function readEulaFlag(sandbox: PathSandbox, root: string): Promise<boolean> {
  const file = await sandbox.resolve(root, 'eula.txt').catch(() => null);
  if (!file) return false;
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  if (raw === null) return false;
  return /^\s*_?eula\s*=\s*true\s*$/im.test(raw);
}

export function registerConfigRoutes(app: FastifyInstance, deps: ConfigRouteDeps): void {
  const { sessions, audit, instances, rcon, sandbox } = deps;
  const { requireAuth, requireOrigin } = createGuards(sessions);
  const read = { preHandler: [requireAuth] };
  const write = { preHandler: [requireOrigin, requireAuth, app.csrfProtection] };

  app.get<{ Params: { id: string } }>(
    '/api/instances/:id/config/properties',
    read,
    async (request): Promise<PropertiesPayload> => {
      const row = instances.get(request.params.id);
      const loaded = await loadServerProperties(row.rootPath, sandbox);
      if (!loaded) throw new AppError('NOT_FOUND', 'server.properties 不存在');
      return { ...loaded.parsed, raw: loaded.raw, mtime: loaded.mtime, eula: await readEulaFlag(sandbox, row.rootPath) };
    },
  );

  app.put<{ Params: { id: string } }>('/api/instances/:id/config/properties', write, async (request) => {
    const row = instances.get(request.params.id);
    const input = propertiesSaveSchema.parse(request.body);
    const loaded = await loadServerProperties(row.rootPath, sandbox);
    if (!loaded) throw new AppError('NOT_FOUND', 'server.properties 不存在');
    if (Math.abs(loaded.mtime - input.expectedMtime) > 0.5) {
      throw new AppError('MTIME_CONFLICT', '文件已被外部修改');
    }
    validatePropertyChanges(input.changes);
    const next = patchProperties(loaded.raw, input.changes);
    const file = await sandbox.resolve(row.rootPath, 'server.properties');
    await writeFileAtomic(file, next);
    rcon.invalidate(row.id);
    audit.record({
      userId: request.user?.id,
      action: 'config.update',
      targetType: 'instance',
      targetId: row.id,
      detail: { keys: Object.keys(input.changes) },
      ip: request.ip,
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/instances/:id/config/eula', write, async (request) => {
    eulaSchema.parse(request.body);
    const row = instances.get(request.params.id);
    const file = await sandbox.resolve(row.rootPath, 'eula.txt');
    const stat = await fs.lstat(file).catch(() => null);
    if (stat?.isDirectory()) throw new AppError('UNSUPPORTED_FILE', 'eula.txt 是目录，请手动处理');
    const existing = stat ? await fs.readFile(file, 'utf8') : null;
    await writeFileAtomic(file, patchEula(existing));
    audit.record({
      userId: request.user?.id,
      action: 'instance.eula_accept',
      targetType: 'instance',
      targetId: row.id,
      ip: request.ip,
    });
    return { ok: true };
  });
}
```

顶部 import 增加 `import fs from 'node:fs/promises';`。

- [ ] **Step 5: 接入 app 与 index**

`apps/server/src/app.ts`：import `registerConfigRoutes` 与 `type PathSandbox`，`AppServices` 增加 `sandbox?: PathSandbox`，并在 files 路由注册块后：

```ts
  if (services.instances && services.rcon && services.sandbox) {
    registerConfigRoutes(app, {
      sessions: services.sessions,
      audit: services.audit,
      instances: services.instances,
      rcon: services.rcon,
      sandbox: services.sandbox,
    });
  }
```

`apps/server/src/index.ts`：services 字面量加入 `sandbox`。

- [ ] **Step 6: 运行测试确认通过**

Run: `npm test -w @mcpanel/server -- test/integration/config-api.test.ts`
Expected: 4 个测试 PASS。

- [ ] **Step 7: 全量校验并提交**

```bash
npm run typecheck && npm test && npm run lint
git add apps/server/src apps/server/test
git commit -m "feat(server): patch server.properties without losing comments or order"
```

---

### Task 5: 一键启用 RCON 与测试连接

**Files:**
- Create: `apps/server/src/services/rcon-config-service.ts`
- Create: `apps/server/src/routes/rcon.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/test/integration/rcon-enable.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/server/test/integration/rcon-enable.test.ts`：

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InstanceService } from '../../src/services/instance-service';
import { PathSandbox } from '../../src/nodes/path-sandbox';
import { RconConfigService, generateRconPassword } from '../../src/services/rcon-config-service';
import { RconService } from '../../src/services/rcon-service';
import { insertInstanceRow } from '../helpers/factory';
import { createTestDb, type TestDb } from '../helpers/db';

let ctx: TestDb | undefined;
const roots: string[] = [];

async function prepare(otherPort?: number) {
  ctx = createTestDb();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-rcon-enable-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'server.properties'), 'motd=hi\nserver-port=25565\n');
  const instance = insertInstanceRow(ctx.db, { rootPath: root });
  if (otherPort !== undefined) {
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-rcon-other-'));
    roots.push(otherRoot);
    await fs.writeFile(path.join(otherRoot, 'server.properties'), `enable-rcon=true\nrcon.port=${otherPort}\n`);
    insertInstanceRow(ctx.db, { rootPath: otherRoot });
  }
  const sandbox = new PathSandbox(ctx.dir);
  const service = new RconConfigService(sandbox, new InstanceService(ctx.db, ctx.dir), new RconService());
  return { service, instance, root };
}

afterEach(async () => {
  ctx?.close();
  ctx = undefined;
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('RconConfigService', () => {
  it('generates 16-character alphanumeric passwords without ambiguous characters', () => {
    const password = generateRconPassword();
    expect(password).toHaveLength(16);
    expect(password).toMatch(/^[A-Za-z0-9]{16}$/);
  });

  it('enables RCON and keeps every other line intact', async () => {
    const { service, instance, root } = await prepare();
    const result = await service.enable(instance);
    expect(result.port).toBe(25575);
    expect(result.password).toMatch(/^[A-Za-z0-9]{16}$/);

    const raw = await fs.readFile(path.join(root, 'server.properties'), 'utf8');
    expect(raw).toContain('motd=hi\n');
    expect(raw).toContain('enable-rcon=true\n');
    expect(raw).toContain(`rcon.password=${result.password}\n`);
    expect(raw).toContain('rcon.port=25575\n');
  });

  it('skips ports already used by another managed instance', async () => {
    const first = await prepare(25575);
    const { service, instance } = first;
    const result = await service.enable(instance);
    expect(result.port).toBe(25576);
  });

  it('fails with PORT_IN_USE when every candidate is taken', async () => {
    ctx = createTestDb();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-rcon-full-'));
    roots.push(root);
    await fs.writeFile(path.join(root, 'server.properties'), 'motd=hi\n');
    const instance = insertInstanceRow(ctx.db, { rootPath: root });
    for (let port = 25575; port <= 25584; port += 1) {
      const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-rcon-taken-'));
      roots.push(otherRoot);
      await fs.writeFile(path.join(otherRoot, 'server.properties'), `enable-rcon=true\nrcon.port=${port}\n`);
      insertInstanceRow(ctx.db, { rootPath: otherRoot });
    }
    const service = new RconConfigService(
      new PathSandbox(ctx.dir),
      new InstanceService(ctx.db, ctx.dir),
      new RconService(),
    );
    await expect(service.enable(instance)).rejects.toMatchObject({ code: 'PORT_IN_USE' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/server -- test/integration/rcon-enable.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 RconConfigService**

`apps/server/src/services/rcon-config-service.ts`：

```ts
import crypto from 'node:crypto';
import type { RconEnableResult } from '@mcpanel/shared';
import type { InstanceRow } from '../db/schema';
import type { PathSandbox } from '../nodes/path-sandbox';
import { AppError } from '../utils/errors';
import { writeFileAtomic } from '../utils/fs-atomic';
import type { InstanceService } from './instance-service';
import { loadServerProperties, parsePort, propertyValue } from './properties-service';
import { patchProperties } from './properties-patch';
import type { RconService } from './rcon-service';

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const PORT_RANGE_START = 25575;
const PORT_RANGE_END = 25584;

export function generateRconPassword(length = 16): string {
  let password = '';
  for (let index = 0; index < length; index += 1) {
    password += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  }
  return password;
}

export class RconConfigService {
  constructor(
    private readonly sandbox: PathSandbox,
    private readonly instances: InstanceService,
    private readonly rcon: RconService,
  ) {}

  async enable(row: InstanceRow): Promise<RconEnableResult> {
    const loaded = await loadServerProperties(row.rootPath, this.sandbox);
    if (!loaded) throw new AppError('NOT_FOUND', 'server.properties 不存在');

    const usedPorts = await this.usedPorts(row.id);
    const currentPort = parsePort(propertyValue(loaded.parsed, 'rcon.port', '25575'), 25575);
    let port: number | null = usedPorts.has(currentPort) ? null : currentPort;
    if (port === null) {
      for (let candidate = PORT_RANGE_START; candidate <= PORT_RANGE_END; candidate += 1) {
        if (!usedPorts.has(candidate)) {
          port = candidate;
          break;
        }
      }
    }
    if (port === null) {
      throw new AppError('PORT_IN_USE', `RCON 端口 ${PORT_RANGE_START}–${PORT_RANGE_END} 均已被其他实例占用`);
    }

    const password = generateRconPassword();
    const next = patchProperties(loaded.raw, {
      'enable-rcon': 'true',
      'rcon.port': String(port),
      'rcon.password': password,
    });
    const file = await this.sandbox.resolve(row.rootPath, 'server.properties');
    await writeFileAtomic(file, next);
    this.rcon.invalidate(row.id);
    return { port, password };
  }

  private async usedPorts(excludeId: string): Promise<Set<number>> {
    const ports = new Set<number>();
    for (const other of this.instances.list()) {
      if (other.id === excludeId) continue;
      const loaded = await loadServerProperties(other.rootPath, this.sandbox).catch(() => null);
      ports.add(parsePort(propertyValue(loaded?.parsed ?? null, 'rcon.port', '25575'), 25575));
    }
    return ports;
  }
}
```

- [ ] **Step 4: 实现 RCON 路由**

`apps/server/src/routes/rcon.ts`：

```ts
import type { FastifyInstance } from 'fastify';
import { createGuards } from '../auth/guard';
import type { SessionService } from '../auth/session';
import type { AuditService } from '../services/audit-service';
import type { InstanceService } from '../services/instance-service';
import type { RconConfigService } from '../services/rcon-config-service';
import type { RconService } from '../services/rcon-service';

export interface RconRouteDeps {
  sessions: SessionService;
  audit: AuditService;
  instances: InstanceService;
  rcon: RconService;
  rconConfig: RconConfigService;
}

export function registerRconRoutes(app: FastifyInstance, deps: RconRouteDeps): void {
  const { sessions, audit, instances, rcon, rconConfig } = deps;
  const { requireAuth, requireOrigin } = createGuards(sessions);
  const write = { preHandler: [requireOrigin, requireAuth, app.csrfProtection] };

  app.post<{ Params: { id: string } }>('/api/instances/:id/rcon/test', write, async (request) => {
    const row = instances.get(request.params.id);
    return rcon.test(row);
  });

  app.post<{ Params: { id: string } }>('/api/instances/:id/rcon/enable', write, async (request) => {
    const row = instances.get(request.params.id);
    const result = await rconConfig.enable(row);
    audit.record({
      userId: request.user?.id,
      action: 'instance.rcon_enable',
      targetType: 'instance',
      targetId: row.id,
      detail: { port: result.port },
      ip: request.ip,
    });
    return { ...result, restartRequired: true };
  });

  app.get<{ Params: { id: string } }>('/api/instances/:id/rcon/status', { preHandler: [requireAuth] }, async (request) =>
    rcon.test(instances.get(request.params.id)),
  );
}
```

> `/rcon/status` 会真实连接一次，只用于手动“测试连接”后的轮询；不要放进 3 秒采样。

- [ ] **Step 5: 接入 app 与 index**

`app.ts`：`AppServices` 增加 `rconConfig?: RconConfigService`；在 files/config 路由块后：

```ts
  if (services.instances && services.rcon && services.rconConfig) {
    registerRconRoutes(app, {
      sessions: services.sessions,
      audit: services.audit,
      instances: services.instances,
      rcon: services.rcon,
      rconConfig: services.rconConfig,
    });
  }
```

`index.ts`：构造 `const rconConfig = new RconConfigService(sandbox, instances, rcon);` 并传入 services。

- [ ] **Step 6: 运行测试确认通过**

Run: `npm test -w @mcpanel/server -- test/integration/rcon-enable.test.ts`
Expected: 4 个测试 PASS。

- [ ] **Step 7: 提交**

```bash
npm run typecheck && npm test && npm run lint
git add apps/server/src apps/server/test
git commit -m "feat(server): add one-click RCON setup with port allocation"
```

---

### Task 6: 玩家列表、名单与操作

**Files:**
- Create: `apps/server/src/services/players-service.ts`
- Create: `apps/server/src/routes/players.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/test/unit/players.test.ts`
- Test: `apps/server/test/integration/players-api.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/server/test/unit/players.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { buildPlayerCommand, parsePlayerList } from '../../src/services/players-service';

describe('parsePlayerList', () => {
  it('parses the vanilla list output', () => {
    expect(parsePlayerList('There are 2 of a max of 20 players online: Steve, Alex')).toEqual({
      online: ['Steve', 'Alex'],
      max: 20,
      warning: null,
    });
  });

  it('parses the legacy slash form and tolerates empty lists', () => {
    expect(parsePlayerList('There are 0/10 players online:')).toEqual({ online: [], max: 10, warning: null });
  });

  it('filters invalid names and warns on unknown output', () => {
    expect(parsePlayerList('There are 1 of a max of 20 players online: Steve, <not a name>').online).toEqual(['Steve']);
    expect(parsePlayerList('Unknown command').warning).toContain('无法解析');
  });
});

describe('buildPlayerCommand', () => {
  it('uses fixed templates for every action', () => {
    expect(buildPlayerCommand({ action: 'op', player: 'Steve' })).toBe('op Steve');
    expect(buildPlayerCommand({ action: 'kick', player: 'Steve', reason: '挂机' })).toBe('kick Steve 挂机');
    expect(buildPlayerCommand({ action: 'ban', player: 'Steve', reason: '' })).toBe('ban Steve');
    expect(buildPlayerCommand({ action: 'gamemode', player: 'Alex', mode: 'creative' })).toBe('gamemode creative Alex');
    expect(buildPlayerCommand({ action: 'broadcast', message: '维护中' })).toBe('say 维护中');
    expect(buildPlayerCommand({ action: 'whitelist_off' })).toBe('whitelist off');
  });
});
```

`apps/server/test/integration/players-api.test.ts`：

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app';
import { LoginThrottle } from '../../src/auth/guard';
import { SessionService } from '../../src/auth/session';
import { loadConfig } from '../../src/config';
import { silentLogger } from '../../src/logger';
import { AuditService } from '../../src/services/audit-service';
import { FileService } from '../../src/services/file-service';
import { InstanceService } from '../../src/services/instance-service';
import { LocalNodeDriver } from '../../src/nodes/local-driver';
import { PathSandbox } from '../../src/nodes/path-sandbox';
import { ProbeService } from '../../src/services/probe-service';
import type { RconService } from '../../src/services/rcon-service';
import type { InstanceSupervisor } from '../../src/services/instance-supervisor';
import { insertInstance, insertUser } from '../helpers/factory';
import { createTestDb, type TestDb } from '../helpers/db';
import { CookieJar, TEST_ORIGIN, json } from '../helpers/http';

let ctx: TestDb | undefined;
const roots: string[] = [];

async function makeApp() {
  ctx = createTestDb();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-players-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'whitelist.json'), JSON.stringify([{ uuid: 'u1', name: 'Steve' }]));
  await fs.writeFile(path.join(root, 'ops.json'), JSON.stringify([{ uuid: 'u1', name: 'Steve', level: 4 }]));
  await fs.writeFile(path.join(root, 'banned-players.json'), JSON.stringify([{ uuid: 'u2', name: 'Herobrine' }]));
  await fs.writeFile(path.join(root, 'banned-ips.json'), JSON.stringify([{ ip: '10.0.0.9' }]));

  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: ctx.dir });
  const sessions = new SessionService(ctx.db);
  const { token } = sessions.create(insertUser(ctx.db), null, null);
  const instanceId = insertInstance(ctx.db, { rootPath: root });
  const sandbox = new PathSandbox(ctx.dir);
  const supervisor = {
    getStatus: () => ({ instanceId, state: 'running', pid: 5, startedAt: null, exitCode: null, error: null }),
  } as unknown as InstanceSupervisor;
  const send = vi.fn(async (_row: unknown, command: string) => {
    if (command === 'list') return 'There are 1 of a max of 20 players online: Steve';
    return `${command}: ok`;
  });
  const rcon = { statusFor: async () => 'connected', send, test: async () => ({ status: 'connected', error: null }) } as unknown as RconService;

  const app = await buildApp(config, ctx.db, {
    sessions,
    audit: new AuditService(ctx.db),
    loginThrottle: new LoginThrottle(),
    instances: new InstanceService(ctx.db, ctx.dir),
    supervisor,
    rcon,
    driver: new LocalNodeDriver(sandbox),
    probe: new ProbeService(sandbox, async () => null),
    files: new FileService(sandbox),
    sandbox,
  }, { logger: silentLogger() });

  const jar = new CookieJar();
  const csrf = await app.inject({ method: 'GET', url: '/api/auth/csrf', headers: { cookie: `mcpanel_session=${token}` } });
  jar.absorb(csrf);
  jar.set('mcpanel_session', token);
  return {
    app,
    instanceId,
    send,
    headers: { origin: TEST_ORIGIN, cookie: jar.header(), 'x-csrf-token': json<{ token: string }>(csrf).token },
    readHeaders: { cookie: jar.header() },
  };
}

afterEach(async () => {
  ctx?.close();
  ctx = undefined;
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('players API', () => {
  it('returns the online list and read-only name lists', async () => {
    const { app, instanceId, readHeaders } = await makeApp();
    const players = await app.inject({ method: 'GET', url: `/api/instances/${instanceId}/players`, headers: readHeaders });
    expect(json<{ online: string[]; max: number }>(players)).toMatchObject({ online: ['Steve'], max: 20 });

    const lists = await app.inject({
      method: 'GET',
      url: `/api/instances/${instanceId}/players/lists`,
      headers: readHeaders,
    });
    expect(json(lists)).toEqual({ whitelist: ['Steve'], ops: ['Steve'], banned: ['Herobrine'], bannedIps: ['10.0.0.9'] });
  });

  it('runs whitelisted actions and audits them', async () => {
    const { app, instanceId, send, headers } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/players/actions`,
      headers,
      payload: { action: 'kick', player: 'Steve', reason: '挂机' },
    });
    expect(res.statusCode).toBe(200);
    expect(send).toHaveBeenCalledWith(expect.anything(), 'kick Steve 挂机');
    const row = ctx!.db.prepare(`SELECT action, detail_json FROM audit_logs WHERE action = 'player.kick'`).get() as
      | { detail_json: string }
      | undefined;
    expect(row).toBeTruthy();
    expect(row!.detail_json).toContain('Steve');
  });

  it('rejects unknown players names and unsupported actions', async () => {
    const { app, instanceId, headers } = await makeApp();
    const badName = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/players/actions`,
      headers,
      payload: { action: 'op', player: 'not a name' },
    });
    expect(badName.statusCode).toBe(400);

    const unknownAction = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/players/actions`,
      headers,
      payload: { action: 'stop_server' },
    });
    expect(unknownAction.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/server -- test/unit/players.test.ts test/integration/players-api.test.ts`
Expected: FAIL，模块与路由不存在。

- [ ] **Step 3: 实现 PlayersService**

`apps/server/src/services/players-service.ts`：

```ts
import fs from 'node:fs/promises';
import type {
  InstanceState,
  PlayerActionInput,
  PlayerListsResponse,
  PlayersResponse,
} from '@mcpanel/shared';
import type { InstanceRow } from '../db/schema';
import type { PathSandbox } from '../nodes/path-sandbox';
import { AppError } from '../utils/errors';
import type { RconService } from './rcon-service';

const LIST_PATTERNS = [
  /There are (\d+) of a max(?: of)? (\d+) players online:?\s*(.*)/i,
  /There are (\d+)\/(\d+) players online:?\s*(.*)/i,
];
const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;

export function parsePlayerList(output: string): { online: string[]; max: number; warning: string | null } {
  for (const pattern of LIST_PATTERNS) {
    const match = pattern.exec(output);
    if (!match) continue;
    const names = (match[3] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => PLAYER_NAME.test(name));
    return { online: names, max: Number(match[2]), warning: null };
  }
  return { online: [], max: 0, warning: '无法解析服务器返回的玩家列表' };
}

export function buildPlayerCommand(input: PlayerActionInput): string {
  switch (input.action) {
    case 'op':
      return `op ${input.player}`;
    case 'deop':
      return `deop ${input.player}`;
    case 'whitelist_add':
      return `whitelist add ${input.player}`;
    case 'whitelist_remove':
      return `whitelist remove ${input.player}`;
    case 'pardon':
      return `pardon ${input.player}`;
    case 'kick':
      return `kick ${input.player} ${input.reason}`.trim();
    case 'ban':
      return `ban ${input.player} ${input.reason}`.trim();
    case 'gamemode':
      return `gamemode ${input.mode} ${input.player}`;
    case 'broadcast':
      return `say ${input.message}`;
    case 'whitelist_on':
      return 'whitelist on';
    case 'whitelist_off':
      return 'whitelist off';
  }
}

async function readNameList(sandbox: PathSandbox, root: string, file: string, pick: 'name' | 'ip'): Promise<string[]> {
  const target = await sandbox.resolve(root, file).catch(() => null);
  if (!target) return [];
  const raw = await fs.readFile(target, 'utf8').catch(() => null);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>)[pick] : undefined))
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
  } catch {
    return [];
  }
}

export class PlayersService {
  constructor(
    private readonly sandbox: PathSandbox,
    private readonly rcon: RconService,
    private readonly getState: (instanceId: string) => InstanceState,
  ) {}

  async online(row: InstanceRow): Promise<PlayersResponse> {
    const state = this.getState(row.id);
    const rconStatus = await this.rcon.statusFor(row);
    if (state !== 'running' && state !== 'orphaned') {
      return { online: [], max: 0, warning: '服务器未运行', rconStatus, state };
    }
    if (rconStatus === 'disabled') {
      return { online: [], max: 0, warning: 'RCON 未启用，无法查询玩家', rconStatus, state };
    }
    try {
      const output = await this.rcon.send(row, 'list');
      return { ...parsePlayerList(output), rconStatus: 'connected', state };
    } catch (error) {
      return {
        online: [],
        max: 0,
        warning: error instanceof AppError ? error.message : 'RCON 查询失败',
        rconStatus: 'unreachable',
        state,
      };
    }
  }

  async lists(row: InstanceRow): Promise<PlayerListsResponse> {
    const [whitelist, ops, banned, bannedIps] = await Promise.all([
      readNameList(this.sandbox, row.rootPath, 'whitelist.json', 'name'),
      readNameList(this.sandbox, row.rootPath, 'ops.json', 'name'),
      readNameList(this.sandbox, row.rootPath, 'banned-players.json', 'name'),
      readNameList(this.sandbox, row.rootPath, 'banned-ips.json', 'ip'),
    ]);
    return { whitelist, ops, banned, bannedIps };
  }

  async act(row: InstanceRow, input: PlayerActionInput): Promise<{ command: string }> {
    const state = this.getState(row.id);
    if (state !== 'running' && state !== 'orphaned') {
      throw new AppError('INVALID_STATE', '服务器未运行，无法执行玩家操作');
    }
    const command = buildPlayerCommand(input);
    await this.rcon.send(row, command);
    return { command };
  }
}
```

- [ ] **Step 4: 实现玩家路由**

`apps/server/src/routes/players.ts`：

```ts
import type { FastifyInstance } from 'fastify';
import { playerActionSchema } from '@mcpanel/shared';
import { createGuards } from '../auth/guard';
import type { SessionService } from '../auth/session';
import type { AuditService } from '../services/audit-service';
import type { InstanceService } from '../services/instance-service';
import type { PlayersService } from '../services/players-service';

export interface PlayerRouteDeps {
  sessions: SessionService;
  audit: AuditService;
  instances: InstanceService;
  players: PlayersService;
}

export function registerPlayerRoutes(app: FastifyInstance, deps: PlayerRouteDeps): void {
  const { sessions, audit, instances, players } = deps;
  const { requireAuth, requireOrigin } = createGuards(sessions);
  const read = { preHandler: [requireAuth] };
  const write = { preHandler: [requireOrigin, requireAuth, app.csrfProtection] };

  app.get<{ Params: { id: string } }>('/api/instances/:id/players', read, async (request) =>
    players.online(instances.get(request.params.id)),
  );

  app.get<{ Params: { id: string } }>('/api/instances/:id/players/lists', read, async (request) =>
    players.lists(instances.get(request.params.id)),
  );

  app.post<{ Params: { id: string } }>('/api/instances/:id/players/actions', write, async (request) => {
    const input = playerActionSchema.parse(request.body);
    const row = instances.get(request.params.id);
    const { command } = await players.act(row, input);
    audit.record({
      userId: request.user?.id,
      action: `player.${input.action}`,
      targetType: 'instance',
      targetId: row.id,
      detail: {
        player: 'player' in input ? input.player : null,
        reason: 'reason' in input && input.reason ? input.reason : null,
        mode: 'mode' in input ? input.mode : null,
        command,
      },
      ip: request.ip,
    });
    return { ok: true };
  });
}
```

- [ ] **Step 5: 接入 app 与 index**

`app.ts`：`AppServices` 增加 `players?: PlayersService`；在 rcon 路由块后：

```ts
  if (services.instances && services.players) {
    registerPlayerRoutes(app, {
      sessions: services.sessions,
      audit: services.audit,
      instances: services.instances,
      players: services.players,
    });
  }
```

`index.ts`：

```ts
const players = new PlayersService(sandbox, rcon, (instanceId) => supervisor.getStatus(instanceId).state);
```

并把 `players` 传入 services。

- [ ] **Step 6: 运行测试确认通过**

Run: `npm test -w @mcpanel/server -- test/unit/players.test.ts test/integration/players-api.test.ts`
Expected: 6 个测试 PASS。

- [ ] **Step 7: 提交**

```bash
npm run typecheck && npm test && npm run lint
git add apps/server/src apps/server/test
git commit -m "feat(server): add player list, name lists and audited player actions"
```

---

### Task 7: 面板设置 API 与审计前缀过滤

**Files:**
- Create: `apps/server/src/services/settings-service.ts`
- Create: `apps/server/src/routes/settings.ts`
- Modify: `packages/shared/src/schemas/common.ts`
- Modify: `apps/server/src/services/audit-service.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/test/integration/settings-api.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { LoginThrottle } from '../../src/auth/guard';
import { SessionService } from '../../src/auth/session';
import { loadConfig } from '../../src/config';
import { silentLogger } from '../../src/logger';
import { AuditService } from '../../src/services/audit-service';
import { SettingsService } from '../../src/services/settings-service';
import { insertUser } from '../helpers/factory';
import { createTestDb, type TestDb } from '../helpers/db';
import { CookieJar, TEST_ORIGIN, json } from '../helpers/http';

let ctx: TestDb | undefined;

async function makeApp() {
  ctx = createTestDb();
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: ctx.dir });
  const sessions = new SessionService(ctx.db);
  const { token } = sessions.create(insertUser(ctx.db), null, null);
  const audit = new AuditService(ctx.db);
  audit.record({ action: 'instance.create', targetType: 'instance', targetId: 'a' });
  audit.record({ action: 'player.kick', targetType: 'instance', targetId: 'a' });
  const app = await buildApp(config, ctx.db, {
    sessions,
    audit,
    loginThrottle: new LoginThrottle(),
    settings: new SettingsService(ctx.db),
  }, { logger: silentLogger() });
  const jar = new CookieJar();
  const csrf = await app.inject({ method: 'GET', url: '/api/auth/csrf', headers: { cookie: `mcpanel_session=${token}` } });
  jar.absorb(csrf);
  jar.set('mcpanel_session', token);
  return {
    app,
    headers: { origin: TEST_ORIGIN, cookie: jar.header(), 'x-csrf-token': json<{ token: string }>(csrf).token },
    readHeaders: { cookie: jar.header() },
  };
}

afterEach(() => {
  ctx?.close();
  ctx = undefined;
});

describe('settings API', () => {
  it('returns defaults and persists partial updates', async () => {
    const { app, headers, readHeaders } = await makeApp();
    expect(json(await app.inject({ method: 'GET', url: '/api/settings', headers: readHeaders }))).toEqual({
      panelName: 'MC Panel',
      defaultTimezone: 'Asia/Shanghai',
      auditRetentionDays: 90,
    });
    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers,
      payload: { panelName: '生存服面板', auditRetentionDays: 30 },
    });
    expect(patched.statusCode).toBe(200);
    expect(json(patched)).toMatchObject({ panelName: '生存服面板', auditRetentionDays: 30, defaultTimezone: 'Asia/Shanghai' });
  });

  it('rejects an invalid timezone', async () => {
    const { app, headers } = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers,
      payload: { defaultTimezone: 'Mars/Base' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('filters the audit log by action prefix', async () => {
    const { app, readHeaders } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/audit?page=1&pageSize=20&action=instance.', headers: readHeaders });
    const body = json<{ items: Array<{ action: string }> }>(res);
    expect(body.items.map((item) => item.action)).toEqual(['instance.create']);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/server -- test/integration/settings-api.test.ts`
Expected: FAIL，`settings` 不在 `AppServices`、`/api/settings` 404、前缀过滤只返回精确匹配。

- [ ] **Step 3: 实现 SettingsService 与路由**

`apps/server/src/services/settings-service.ts`：

```ts
import type { PanelSettings } from '@mcpanel/shared';
import { inArray } from 'drizzle-orm';
import type { DB } from '../db/client';
import { settings } from '../db/schema';

const KEYS = {
  panelName: 'panel_name',
  defaultTimezone: 'default_timezone',
  auditRetentionDays: 'audit_retention_days',
} as const;

export const DEFAULT_SETTINGS: PanelSettings = {
  panelName: 'MC Panel',
  defaultTimezone: 'Asia/Shanghai',
  auditRetentionDays: 90,
};

export class SettingsService {
  constructor(private readonly db: DB) {}

  get(): PanelSettings {
    const rows = this.db.select().from(settings).where(inArray(settings.key, Object.values(KEYS))).all();
    const stored = new Map(rows.map((row) => [row.key, row.value]));
    const retention = Number(stored.get(KEYS.auditRetentionDays));
    return {
      panelName: stored.get(KEYS.panelName) ?? DEFAULT_SETTINGS.panelName,
      defaultTimezone: stored.get(KEYS.defaultTimezone) ?? DEFAULT_SETTINGS.defaultTimezone,
      auditRetentionDays:
        Number.isInteger(retention) && retention >= 1 && retention <= 3650 ? retention : DEFAULT_SETTINGS.auditRetentionDays,
    };
  }

  update(patch: Partial<PanelSettings>): PanelSettings {
    const now = Date.now();
    for (const [field, key] of Object.entries(KEYS) as Array<[keyof PanelSettings, string]>) {
      const value = patch[field];
      if (value === undefined) continue;
      this.db
        .insert(settings)
        .values({ key, value: String(value), updatedAt: now })
        .onConflictDoUpdate({ target: settings.key, set: { value: String(value), updatedAt: now } })
        .run();
    }
    return this.get();
  }
}
```

`apps/server/src/routes/settings.ts`：

```ts
import type { FastifyInstance } from 'fastify';
import { panelSettingsPatchSchema } from '@mcpanel/shared';
import { createGuards } from '../auth/guard';
import type { SessionService } from '../auth/session';
import type { AuditService } from '../services/audit-service';
import type { SettingsService } from '../services/settings-service';

export function registerSettingsRoutes(
  app: FastifyInstance,
  deps: { sessions: SessionService; audit: AuditService; settings: SettingsService },
): void {
  const { sessions, audit, settings } = deps;
  const { requireAuth, requireOrigin } = createGuards(sessions);

  app.get('/api/settings', { preHandler: [requireAuth] }, async () => settings.get());

  app.patch(
    '/api/settings',
    { preHandler: [requireOrigin, requireAuth, app.csrfProtection] },
    async (request) => {
      const patch = panelSettingsPatchSchema.parse(request.body);
      const next = settings.update(patch);
      audit.record({
        userId: request.user?.id,
        action: 'settings.update',
        targetType: 'settings',
        targetId: null,
        detail: { fields: Object.keys(patch) },
        ip: request.ip,
      });
      return next;
    },
  );
}
```

- [ ] **Step 4: 审计前缀过滤**

`packages/shared/src/schemas/common.ts` 的 `action` 改为：

```ts
  action: z
    .string()
    .trim()
    .max(80)
    .regex(/^[A-Za-z0-9._-]+$/, '动作过滤只支持字母、数字、点、下划线和连字符')
    .optional(),
```

`apps/server/src/services/audit-service.ts`：import `like`，把 `where` 改为：

```ts
    const where = query.action ? like(auditLogs.action, `${query.action}%`) : undefined;
```

- [ ] **Step 5: 接入 app 与 index**

`app.ts`：`AppServices` 增加 `settings?: SettingsService`，在 `registerAuditRoutes` 之后：

```ts
  if (services.settings) {
    registerSettingsRoutes(app, { sessions: services.sessions, audit: services.audit, settings: services.settings });
  }
```

`index.ts`：`const settings = new SettingsService(handle.db);` 并传入 services。

- [ ] **Step 6: 运行测试确认通过**

Run: `npm test -w @mcpanel/server -- test/integration/settings-api.test.ts`
Expected: 3 个测试 PASS。

- [ ] **Step 7: 提交**

```bash
npm run typecheck && npm test && npm run lint
git add packages/shared/src apps/server/src apps/server/test
git commit -m "feat(server): add panel settings API and audit prefix filtering"
```

---

### Task 8: 玩家页签、像素头像与一键启用 RCON

**Files:**
- Modify: `apps/web/src/components/ui/index.tsx`（新增 `Menu`/`MenuItem`）
- Create: `apps/web/src/components/PlayerAvatar.tsx`
- Create: `apps/web/src/components/PlayerList.tsx`
- Create: `apps/web/src/components/RconEnableDialog.tsx`
- Create: `apps/web/src/pages/instance/PlayersTab.tsx`
- Modify: `apps/web/src/layouts/InstanceLayout.tsx`（页签）
- Modify: `apps/web/src/router.tsx`
- Test: `apps/web/test/player-list.test.tsx`

- [ ] **Step 1: 写失败测试**

`apps/web/test/player-list.test.tsx`：

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PlayerList } from '../src/components/PlayerList';

function renderList(onAction = vi.fn(async () => undefined)) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PlayerList players={['Steve', 'Alex']} onAction={onAction} />
    </QueryClientProvider>,
  );
  return onAction;
}

describe('PlayerList', () => {
  it('renders one row per player and sends an OP action', async () => {
    const onAction = renderList();
    expect(screen.getByText('Steve')).toBeInTheDocument();
    expect(screen.getByText('Alex')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: '玩家操作' })[0]!);
    await user.click(screen.getByRole('menuitem', { name: '设为 OP' }));

    expect(onAction).toHaveBeenCalledWith({ action: 'op', player: 'Steve' });
  });

  it('asks for a reason before kicking', async () => {
    const onAction = renderList();
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: '玩家操作' })[0]!);
    await user.click(screen.getByRole('menuitem', { name: '踢出' }));
    await user.type(screen.getByLabelText('原因'), '挂机');
    await user.click(screen.getByRole('button', { name: '确认踢出' }));

    expect(onAction).toHaveBeenCalledWith({ action: 'kick', player: 'Steve', reason: '挂机' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/web -- test/player-list.test.tsx`
Expected: FAIL，`PlayerList` 不存在。

- [ ] **Step 3: 实现 UI 菜单原语**

`apps/web/src/components/ui/index.tsx` 顶部 import 增加：

```tsx
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
```

文件末尾追加：

```tsx
export function Menu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" className="h-8 px-2" aria-label={label}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          className="z-50 min-w-40 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 text-sm shadow-lg"
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function MenuItem({
  onSelect,
  danger = false,
  disabled = false,
  children,
}: {
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'cursor-pointer rounded-md px-3 py-1.5 outline-none data-[highlighted]:bg-[var(--surface-2)]',
        danger && 'text-[var(--danger)]',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      {children}
    </DropdownMenu.Item>
  );
}
```

`MoreHorizontal` 加入 lucide import。

- [ ] **Step 4: 实现头像、玩家列表与启用对话框**

`apps/web/src/components/PlayerAvatar.tsx`：

```tsx
function hashName(name: string): number {
  let hash = 2166136261;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function PlayerAvatar({ name, size = 28 }: { name: string; size?: number }) {
  const hash = hashName(name);
  const hue = hash % 360;
  const cells = Array.from({ length: 25 }, (_value, index) => {
    const row = Math.floor(index / 5);
    const column = index % 5;
    const mirrored = column > 2 ? row * 5 + (4 - column) : index;
    return ((hash >> (mirrored % 24)) & 1) === 1;
  });
  return (
    <div
      className="grid shrink-0 grid-cols-5 gap-px overflow-hidden rounded"
      style={{ width: size, height: size, backgroundColor: `hsl(${hue} 45% 18%)` }}
      aria-hidden="true"
    >
      {cells.map((filled, index) => (
        <span key={index} style={{ backgroundColor: filled ? `hsl(${hue} 65% 55%)` : 'transparent' }} />
      ))}
    </div>
  );
}
```

`apps/web/src/components/PlayerList.tsx`：

```tsx
import { useState } from 'react';
import type { PlayerActionInput } from '@mcpanel/shared';
import { PlayerAvatar } from './PlayerAvatar';
import { Button, Dialog, Field, Input, Menu, MenuItem, Select } from './ui';

type PlayerMode = 'survival' | 'creative' | 'adventure' | 'spectator';

type Pending =
  | { kind: 'reason'; action: 'kick' | 'ban'; player: string }
  | { kind: 'gamemode'; player: string }
  | null;

const reasonLabel: Record<'kick' | 'ban', string> = { kick: '踢出', ban: '封禁' };

export function PlayerList({
  players,
  onAction,
}: {
  players: string[];
  onAction: (input: PlayerActionInput) => void | Promise<void>;
}) {
  const [pending, setPending] = useState<Pending>(null);
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<PlayerMode>('survival');

  const quick = (action: PlayerActionInput) => {
    void onAction(action);
    setPending(null);
  };

  return (
    <div className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--surface)]">
      {players.map((player) => (
        <div key={player} className="flex items-center gap-3 px-4 py-2.5">
          <PlayerAvatar name={player} />
          <span className="min-w-0 flex-1 truncate text-sm">{player}</span>
          <Menu label="玩家操作">
            <MenuItem onSelect={() => quick({ action: 'op', player })}>设为 OP</MenuItem>
            <MenuItem onSelect={() => quick({ action: 'deop', player })}>取消 OP</MenuItem>
            <MenuItem onSelect={() => quick({ action: 'whitelist_add', player })}>加入白名单</MenuItem>
            <MenuItem onSelect={() => quick({ action: 'whitelist_remove', player })}>移出白名单</MenuItem>
            <MenuItem
              onSelect={() => {
                setReason('');
                setPending({ kind: 'reason', action: 'kick', player });
              }}
            >
              踢出
            </MenuItem>
            <MenuItem
              danger
              onSelect={() => {
                setReason('');
                setPending({ kind: 'reason', action: 'ban', player });
              }}
            >
              封禁
            </MenuItem>
            <MenuItem onSelect={() => quick({ action: 'pardon', player })}>解除封禁</MenuItem>
            <MenuItem
              onSelect={() => {
                setMode('survival');
                setPending({ kind: 'gamemode', player });
              }}
            >
              切换游戏模式
            </MenuItem>
          </Menu>
        </div>
      ))}

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => (!open ? setPending(null) : undefined)}
        title={pending?.kind === 'reason' ? `确认${reasonLabel[pending.action]}` : `切换 ${pending?.player ?? ''} 的游戏模式`}
        description={pending?.kind === 'reason' ? `对 ${pending.player} 执行${reasonLabel[pending.action]}，原因会记录在服务器日志中。` : '切换后立即生效。'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPending(null)}>
              取消
            </Button>
            <Button
              variant={pending?.kind === 'reason' && pending.action === 'ban' ? 'danger' : 'primary'}
              onClick={() => {
                if (!pending) return;
                if (pending.kind === 'reason') {
                  void onAction({ action: pending.action, player: pending.player, reason });
                } else {
                  void onAction({ action: 'gamemode', player: pending.player, mode });
                }
                setPending(null);
              }}
            >
              {pending?.kind === 'reason' ? `确认${reasonLabel[pending.action]}` : '确认切换'}
            </Button>
          </>
        }
      >
        {pending?.kind === 'reason' && (
          <Field label="原因">
            <Input value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} placeholder="可选" />
          </Field>
        )}
        {pending?.kind === 'gamemode' && (
          <Field label="游戏模式">
            <Select value={mode} onChange={(event) => setMode(event.target.value as PlayerMode)}>
              <option value="survival">生存</option>
              <option value="creative">创造</option>
              <option value="adventure">冒险</option>
              <option value="spectator">旁观</option>
            </Select>
          </Field>
        )}
      </Dialog>
    </div>
  );
}
```

`apps/web/src/components/RconEnableDialog.tsx`：

```tsx
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { RconEnableResult } from '@mcpanel/shared';
import { api, ApiError } from '../api/client';
import { Button, Dialog, ErrorState, Notice, toast } from './ui';

export function RconEnableDialog({
  instanceId,
  open,
  onOpenChange,
  onEnabled,
}: {
  instanceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnabled: () => void;
}) {
  const [result, setResult] = useState<RconEnableResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const enable = useMutation({
    mutationFn: () => api.post<RconEnableResult & { restartRequired: boolean }>(`/instances/${instanceId}/rcon/enable`),
    onSuccess: (data) => {
      setResult(data);
      onEnabled();
      toast('RCON 已写入配置，重启服务器后生效', 'success');
    },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : '启用失败'),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setResult(null);
          setError(null);
        }
        onOpenChange(next);
      }}
      title="启用 RCON"
      description={result ? '密码已写入 server.properties，请妥善保存。' : '面板会生成随机密码并写入 server.properties，需要重启服务器后生效。'}
      footer={
        result ? (
          <Button onClick={() => onOpenChange(false)}>完成</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button loading={enable.isPending} onClick={() => enable.mutate()}>
              生成并写入
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        {result ? (
          <>
            <div className="flex items-center gap-2 rounded-lg bg-[var(--surface-2)] p-3">
              <code className="console-font min-w-0 flex-1 truncate">{result.password}</code>
              <Button
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(result.password).then(() => toast('密码已复制', 'success'));
                }}
              >
                复制
              </Button>
            </div>
            <div>端口：{result.port}</div>
            <Notice tone="warning">重启服务器后玩家管理才会生效。</Notice>
          </>
        ) : (
          <p className="text-[var(--muted)]">
            将写入 <code className="console-font">enable-rcon=true</code>、<code className="console-font">rcon.port</code> 与随机密码；
            如果 25575–25584 都被其他实例占用，会返回错误并提示先调整端口。
          </p>
        )}
        {error && <ErrorState message={error} />}
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 5: 实现玩家页签并接入路由**

`apps/web/src/pages/instance/PlayersTab.tsx`：

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { PlayerActionInput, PlayerListsResponse, PlayersResponse } from '@mcpanel/shared';
import type { InstanceOutletContext } from '../../layouts/InstanceLayout';
import { api, ApiError } from '../../api/client';
import { PlayerList } from '../../components/PlayerList';
import { RconEnableDialog } from '../../components/RconEnableDialog';
import { Button, Dialog, EmptyState, ErrorState, Field, Input, Notice, Spinner, toast } from '../../components/ui';
import { RCON_LABELS } from '../../utils/labels';

function NameList({ title, names }: { title: string; names: string[] }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="text-sm font-medium">
        {title}（{names.length}）
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-[var(--muted)]">
        {names.length > 0 ? names.map((name) => <span key={name} className="rounded bg-[var(--surface-2)] px-2 py-0.5">{name}</span>) : '暂无'}
      </div>
    </div>
  );
}

export function PlayersTab() {
  const { instance, status } = useOutletContext<InstanceOutletContext>();
  const [enableOpen, setEnableOpen] = useState(false);
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [broadcastText, setBroadcastText] = useState('');
  const queryClient = useQueryClient();

  const players = useQuery({
    queryKey: ['players', instance.id],
    queryFn: () => api.get<PlayersResponse>(`/instances/${instance.id}/players`),
    refetchInterval: 10_000,
  });
  const lists = useQuery({
    queryKey: ['player-lists', instance.id],
    queryFn: () => api.get<PlayerListsResponse>(`/instances/${instance.id}/players/lists`),
    refetchInterval: 30_000,
  });

  const action = useMutation({
    mutationFn: (input: PlayerActionInput) => api.post(`/instances/${instance.id}/players/actions`, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['players', instance.id] });
      toast('操作已发送', 'success');
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '操作失败', 'error'),
  });

  const rconStatus = players.data?.rconStatus ?? instance.rconStatus;
  const running = status.state === 'running' || status.state === 'orphaned';
  const online = players.data?.online ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-[var(--muted)]">
          在线 {online.length} / {players.data?.max ?? 0} · RCON：{RCON_LABELS[rconStatus]}
        </div>
        <div className="flex gap-2">
          {rconStatus === 'disabled' && (
            <Button onClick={() => setEnableOpen(true)}>启用 RCON</Button>
          )}
        </div>
      </div>

      {!running && <Notice tone="warning">服务器未运行，玩家列表为空。启动后才能执行玩家操作。</Notice>}
      {running && rconStatus === 'disabled' && <Notice tone="warning">RCON 未启用，无法查询或管理玩家。</Notice>}
      {running && (rconStatus === 'auth_failed' || rconStatus === 'unreachable') && (
        <Notice tone="warning">RCON 连接失败（{RCON_LABELS[rconStatus]}），请检查密码、端口和防火墙。</Notice>
      )}
      {players.data?.warning && running && <Notice tone="info">{players.data.warning}</Notice>}
      {players.isError && <ErrorState message="玩家列表加载失败" />}

      <div className="flex items-center justify-between">
        <h2 className="font-semibold">在线玩家</h2>
        <div className="flex gap-2">
          <Button variant="secondary" disabled={!running || rconStatus !== 'connected'} onClick={() => action.mutate({ action: 'whitelist_on' })}>
            开启白名单
          </Button>
          <Button variant="secondary" disabled={!running || rconStatus !== 'connected'} onClick={() => action.mutate({ action: 'whitelist_off' })}>
            关闭白名单
          </Button>
          <Button variant="secondary" disabled={!running || rconStatus !== 'connected'} onClick={() => setBroadcastOpen(true)}>
            广播
          </Button>
        </div>
      </div>

      {players.isLoading ? (
        <Spinner />
      ) : online.length === 0 ? (
        <EmptyState title="没有在线玩家" description={running ? '服务器正在运行，等待玩家加入。' : '启动服务器后这里会显示在线玩家。'} />
      ) : (
        <PlayerList players={online} onAction={(input) => action.mutate(input)} />
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <NameList title="白名单" names={lists.data?.whitelist ?? []} />
        <NameList title="OP" names={lists.data?.ops ?? []} />
        <NameList title="封禁玩家" names={lists.data?.banned ?? []} />
        <NameList title="封禁 IP" names={lists.data?.bannedIps ?? []} />
      </div>

      <Dialog
        open={broadcastOpen}
        onOpenChange={(open) => {
          setBroadcastOpen(open);
          if (!open) setBroadcastText('');
        }}
        title="广播消息"
        description="以服务器身份向所有在线玩家发送一条消息。"
        footer={
          <>
            <Button variant="secondary" onClick={() => setBroadcastOpen(false)}>
              取消
            </Button>
            <Button
              disabled={!broadcastText.trim() || action.isPending}
              onClick={() => {
                void action.mutateAsync({ action: 'broadcast', message: broadcastText.trim() }).then(() => {
                  setBroadcastOpen(false);
                  setBroadcastText('');
                }).catch(() => undefined);
              }}
            >
              发送
            </Button>
          </>
        }
      >
        <Field label="消息">
          <Input value={broadcastText} maxLength={256} onChange={(event) => setBroadcastText(event.target.value)} />
        </Field>
      </Dialog>

      <RconEnableDialog
        instanceId={instance.id}
        open={enableOpen}
        onOpenChange={setEnableOpen}
        onEnabled={() => {
          void queryClient.invalidateQueries({ queryKey: ['instances'] });
          void queryClient.invalidateQueries({ queryKey: ['players', instance.id] });
        }}
      />
    </div>
  );
}
```

`InstanceLayout.tsx` 的 `tabs` 增加 `{ to: 'players', label: '玩家' }`（放在控制台之后）。

`router.tsx`：

```tsx
import { PlayersTab } from './pages/instance/PlayersTab';
...
          <Route path="players" element={<PlayersTab />} />
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npm test -w @mcpanel/web -- test/player-list.test.tsx && npm run typecheck -w @mcpanel/web`
Expected: 2 个测试 PASS。

- [ ] **Step 7: 提交**

```bash
npm run typecheck && npm test && npm run lint
git add apps/web/src apps/web/test
git commit -m "feat(web): add players tab, pixel avatars and RCON setup"
```

---

### Task 9: 文件页签与浏览器

**Files:**
- Modify: `apps/web/src/api/client.ts`（新增 `uploadFile`）
- Create: `apps/web/src/components/FileBrowser.tsx`
- Create: `apps/web/src/pages/instance/FilesTab.tsx`
- Modify: `apps/web/src/layouts/InstanceLayout.tsx`（页签）
- Modify: `apps/web/src/router.tsx`
- Test: `apps/web/test/file-browser.test.tsx`

- [ ] **Step 1: 写失败测试**

`apps/web/test/file-browser.test.tsx`：

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { FileBrowser } from '../src/components/FileBrowser';

vi.mock('../src/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {},
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
  clearCsrfToken: vi.fn(),
  UNAUTHORIZED_EVENT: 'mcpanel:unauthorized',
}));

afterEach(() => vi.clearAllMocks());

function renderBrowser(onEdit = vi.fn()) {
  (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
    path: '/',
    entries: [
      { name: 'mods', type: 'directory', size: 0, mtime: '2026-10-24T00:00:00.000Z', symlink: false, editable: false },
      { name: 'server.properties', type: 'file', size: 42, mtime: '2026-10-24T00:00:00.000Z', symlink: false, editable: true },
    ],
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <FileBrowser instanceId="i1" path="/" onPathChange={() => undefined} onEdit={onEdit} />
    </QueryClientProvider>,
  );
  return onEdit;
}

describe('FileBrowser', () => {
  it('lists directories before files and opens the editor for text files', async () => {
    const onEdit = renderBrowser();
    expect(await screen.findByText('mods')).toBeInTheDocument();
    expect(screen.getByText('server.properties')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: '文件操作' })[1]!);
    await user.click(screen.getByRole('menuitem', { name: '编辑' }));
    expect(onEdit).toHaveBeenCalledWith('/server.properties');
  });

  it('navigates into a directory', async () => {
    renderBrowser();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'mods' }));
    expect(screen.getByRole('button', { name: 'mods' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/web -- test/file-browser.test.tsx`
Expected: FAIL，组件不存在。

- [ ] **Step 3: 增加上传与 PUT 辅助函数**

`apps/web/src/api/client.ts` 的 `api` 对象增加 `put`：

```ts
export const api = {
  get: <T>(path: string, signal?: AbortSignal) => apiRequest<T>(path, { signal }),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  del: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'DELETE', body }),
};
```

文件末尾追加：

```ts
export async function uploadFile<T>(path: string, formData: FormData): Promise<T> {
  const send = (token: string) =>
    fetch(`/api${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': token },
      body: formData,
    });

  let response = await send(csrfToken ?? (await refreshCsrf()));
  if (response.status === 403) {
    const probe = (await response.clone().json().catch(() => null)) as ApiErrorBody | null;
    if (probe?.error?.code === 'CSRF_INVALID') {
      clearCsrfToken();
      response = await send(await refreshCsrf());
    }
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(data?.error?.code ?? 'INTERNAL', data?.error?.message ?? `上传失败（HTTP ${response.status}）`, response.status);
  }
  return (await response.json()) as T;
}
```

- [ ] **Step 4: 实现 FileBrowser 与 FilesTab**

`apps/web/src/components/FileBrowser.tsx`：

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { File as FileIcon, Folder, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import type { FileEntryInfo, FileListResult } from '@mcpanel/shared';
import { api, ApiError, downloadFile, uploadFile } from '../api/client';
import { Button, ConfirmDialog, Dialog, ErrorState, Field, Input, Menu, MenuItem, Spinner, toast } from './ui';
import { formatBytes, formatDateTime } from '../utils/format';

function breadcrumbs(path: string): Array<{ label: string; path: string }> {
  const parts = path.split('/').filter(Boolean);
  const items = [{ label: '根目录', path: '/' }];
  parts.forEach((part, index) => {
    items.push({ label: part, path: `/${parts.slice(0, index + 1).join('/')}` });
  });
  return items;
}

type Pending =
  | { kind: 'mkdir' }
  | { kind: 'rename'; entry: FileEntryInfo }
  | { kind: 'delete'; entry: FileEntryInfo }
  | { kind: 'unzip'; entry: FileEntryInfo }
  | null;

export function FileBrowser({
  instanceId,
  path,
  onPathChange,
  onEdit,
}: {
  instanceId: string;
  path: string;
  onPathChange: (path: string) => void;
  onEdit: (path: string) => void;
}) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [value, setValue] = useState('');
  const [confirmName, setConfirmName] = useState('');

  const list = useQuery({
    queryKey: ['files', instanceId, path],
    queryFn: () => api.get<FileListResult>(`/instances/${instanceId}/files?path=${encodeURIComponent(path)}`),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['files', instanceId] });

  const mutate = useMutation({
    mutationFn: async (action: () => Promise<unknown>) => action(),
    onSuccess: async () => {
      await refresh();
      setPending(null);
      setValue('');
      setConfirmName('');
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '操作失败', 'error'),
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.set('path', path);
      form.set('file', file);
      return uploadFile<{ path: string }>(`/instances/${instanceId}/files/upload`, form);
    },
    onSuccess: async () => {
      await refresh();
      toast('上传完成', 'success');
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '上传失败', 'error'),
  });

  const crumbs = breadcrumbs(path);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1 text-sm">
            {crumbs.map((crumb, index) => (
              <span key={crumb.path} className="flex items-center gap-1">
                {index > 0 && <span className="text-[var(--muted)]">/</span>}
                <button
                  type="button"
                  className="rounded px-1 hover:bg-[var(--surface-2)]"
                  onClick={() => onPathChange(crumb.path)}
                >
                  {crumb.label}
                </button>
              </span>
            ))}
          </div>
        </div>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) upload.mutate(file);
            event.target.value = '';
          }}
        />
        <Button variant="secondary" loading={upload.isPending} onClick={() => inputRef.current?.click()}>
          <Upload className="h-4 w-4" />
          上传
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setValue('');
            setPending({ kind: 'mkdir' });
          }}
        >
          新建目录
        </Button>
      </div>

      {list.isLoading ? (
        <Spinner />
      ) : list.isError ? (
        <ErrorState message="目录加载失败" />
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          {(list.data?.entries.length ?? 0) === 0 && <div className="px-4 py-8 text-center text-sm text-[var(--muted)]">空目录</div>}
          {list.data?.entries.map((entry) => {
            const entryPath = `${path.replace(/\/$/, '')}/${entry.name}`;
            return (
              <div key={entry.name} className="flex items-center gap-3 border-b border-[var(--border)] px-3 py-2 last:border-0">
                {entry.type === 'directory' ? (
                  <Folder className="h-4 w-4 shrink-0 text-[var(--primary)]" aria-hidden="true" />
                ) : (
                  <FileIcon className="h-4 w-4 shrink-0 text-[var(--muted)]" aria-hidden="true" />
                )}
                <button
                  type="button"
                  aria-label={entry.name}
                  className="min-w-0 flex-1 truncate text-left text-sm hover:text-[var(--primary)]"
                  onClick={() => (entry.type === 'directory' ? onPathChange(entryPath) : entry.editable && onEdit(entryPath))}
                >
                  {entry.name}
                </button>
                <span className="hidden w-20 shrink-0 text-right text-xs text-[var(--muted)] sm:block">
                  {entry.type === 'file' ? formatBytes(entry.size) : '—'}
                </span>
                <span className="hidden w-36 shrink-0 text-right text-xs text-[var(--muted)] md:block">{formatDateTime(entry.mtime)}</span>
                <Menu label="文件操作">
                  {entry.type === 'file' && entry.editable && <MenuItem onSelect={() => onEdit(entryPath)}>编辑</MenuItem>}
                  {entry.type === 'file' && (
                    <MenuItem
                      onSelect={() => {
                        void downloadFile(`/instances/${instanceId}/files/download?path=${encodeURIComponent(entryPath)}`, entry.name).catch(
                          (cause: unknown) => toast(cause instanceof ApiError ? cause.message : '下载失败', 'error'),
                        );
                      }}
                    >
                      下载
                    </MenuItem>
                  )}
                  {entry.type === 'file' && entry.name.endsWith('.zip') && (
                    <MenuItem
                      onSelect={() => {
                        setValue('');
                        setPending({ kind: 'unzip', entry });
                      }}
                    >
                      解压到当前目录
                    </MenuItem>
                  )}
                  {/\.jar(\.disabled)?$/.test(entry.name) && path.replace(/\/$/, '') === '/mods' && (
                    <MenuItem
                      onSelect={() =>
                        void api
                          .post(`/instances/${instanceId}/files/mods/toggle`, { path: entryPath })
                          .then(refresh)
                          .catch((cause: unknown) => toast(cause instanceof ApiError ? cause.message : '操作失败', 'error'))
                      }
                    >
                      {entry.name.endsWith('.disabled') ? '启用模组' : '禁用模组'}
                    </MenuItem>
                  )}
                  <MenuItem
                    onSelect={() => {
                      setValue(entry.name);
                      setPending({ kind: 'rename', entry });
                    }}
                  >
                    重命名
                  </MenuItem>
                  <MenuItem
                    danger
                    onSelect={() => {
                      setConfirmName('');
                      setPending({ kind: 'delete', entry });
                    }}
                  >
                    删除
                  </MenuItem>
                </Menu>
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={pending?.kind === 'mkdir' || pending?.kind === 'rename'}
        onOpenChange={(open) => (!open ? setPending(null) : undefined)}
        title={pending?.kind === 'rename' ? '重命名' : '新建目录'}
        description={pending?.kind === 'rename' ? `重命名 ${pending.entry.name}` : `在 ${path} 下创建目录`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPending(null)}>
              取消
            </Button>
            <Button
              loading={mutate.isPending}
              onClick={() => {
                if (!pending) return;
                if (pending.kind === 'mkdir') {
                  mutate.mutate(() => api.post(`/instances/${instanceId}/files/mkdir`, { path: `${path.replace(/\/$/, '')}/${value}` }));
                } else if (pending.kind === 'rename') {
                  mutate.mutate(() => api.post(`/instances/${instanceId}/files/rename`, { path: `${path.replace(/\/$/, '')}/${pending.entry.name}`, newName: value }));
                }
              }}
            >
              确认
            </Button>
          </>
        }
      >
        <Field label="名称">
          <Input value={value} onChange={(event) => setValue(event.target.value)} />
        </Field>
      </Dialog>

      <Dialog
        open={pending?.kind === 'unzip'}
        onOpenChange={(open) => (!open ? setPending(null) : undefined)}
        title="解压压缩包"
        description="只支持 zip；解压前会校验路径、条目数与体积上限。"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPending(null)}>
              取消
            </Button>
            <Button
              loading={mutate.isPending}
              onClick={() => {
                if (pending?.kind !== 'unzip') return;
                mutate.mutate(() =>
                  api.post(`/instances/${instanceId}/files/unzip`, {
                    path: `${path.replace(/\/$/, '')}/${pending.entry.name}`,
                    targetDir: path,
                  }),
                );
              }}
            >
              解压
            </Button>
          </>
        }
      >
        <p className="text-sm text-[var(--muted)]">解压到 {path}</p>
      </Dialog>

      <ConfirmDialog
        open={pending?.kind === 'delete'}
        onOpenChange={(open) => (!open ? setPending(null) : undefined)}
        title="删除"
        description={
          pending?.kind === 'delete' && pending.entry.type === 'directory'
            ? `目录 ${pending.entry.name} 及其内容会被递归删除。输入名称以确认。`
            : `文件 ${pending?.kind === 'delete' ? pending.entry.name : ''} 会被删除，无法从面板恢复。`
        }
        confirmLabel="删除"
        danger
        confirmDisabled={pending?.kind === 'delete' && pending.entry.type === 'directory' && confirmName !== pending.entry.name}
        loading={mutate.isPending}
        onConfirm={() => {
          if (pending?.kind !== 'delete') return;
          mutate.mutate(() =>
            api.del(`/instances/${instanceId}/files`, {
              path: `${path.replace(/\/$/, '')}/${pending.entry.name}`,
              recursive: pending.entry.type === 'directory',
            }),
          );
        }}
      >
        {pending?.kind === 'delete' && pending.entry.type === 'directory' && (
          <Field label="确认目录名">
            <Input value={confirmName} onChange={(event) => setConfirmName(event.target.value)} placeholder={pending.entry.name} />
          </Field>
        )}
      </ConfirmDialog>
    </div>
  );
}
```

> 编辑入口只调用 `onEdit(path)`，内容预取与冲突处理在下文的 `FileEditorDialog` 里完成。

`apps/web/src/components/FileEditorDialog.tsx`：

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { TextFileContent } from '@mcpanel/shared';
import { api, ApiError } from '../api/client';
import { Button, Dialog, ErrorState, Spinner, toast } from './ui';

export function FileEditorDialog({
  instanceId,
  path,
  onOpenChange,
}: {
  instanceId: string;
  path: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [content, setContent] = useState('');
  const [mtime, setMtime] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<TextFileContent | null>(null);

  const file = useQuery({
    queryKey: ['file-content', instanceId, path],
    queryFn: () =>
      api.get<TextFileContent>(`/instances/${instanceId}/files/content?path=${encodeURIComponent(path ?? '')}`),
    enabled: Boolean(path),
  });

  useEffect(() => {
    if (!file.data) return;
    setContent(file.data.content);
    setMtime(file.data.mtime);
    setConflict(null);
    setError(null);
  }, [file.data]);

  const save = useMutation({
    mutationFn: (expectedMtime: number) => {
      if (!path) throw new Error('缺少文件路径');
      return api.put<{ mtime: number }>(`/instances/${instanceId}/files/content`, {
        path,
        content,
        expectedMtime,
      });
    },
    onSuccess: async (result) => {
      setMtime(result.mtime);
      setConflict(null);
      await queryClient.invalidateQueries({ queryKey: ['files', instanceId] });
      toast('已保存', 'success');
    },
    onError: async (cause) => {
      if (cause instanceof ApiError && cause.code === 'MTIME_CONFLICT' && path) {
        try {
          const latest = await api.get<TextFileContent>(
            `/instances/${instanceId}/files/content?path=${encodeURIComponent(path)}`,
          );
          setConflict(latest);
        } catch {
          setError('文件已被外部修改，且重新读取失败');
        }
        return;
      }
      setError(cause instanceof ApiError ? cause.message : '保存失败');
    },
  });

  return (
    <Dialog
      open={Boolean(path)}
      onOpenChange={onOpenChange}
      title={path ?? ''}
      description="保存时会校验文件修改时间，外部改动会提示冲突。"
      wide
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button loading={save.isPending} disabled={mtime === null} onClick={() => mtime !== null && save.mutate(mtime)}>
            保存
          </Button>
        </>
      }
    >
      {file.isLoading ? (
        <Spinner />
      ) : file.isError ? (
        <ErrorState message="文件读取失败或不是文本文件" />
      ) : (
        <div className="flex flex-col gap-3">
          <textarea
            className="console-font h-80 w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--console-bg)] p-3 text-xs leading-5 text-[var(--console-fg)] focus:border-[var(--primary)] focus:outline-none"
            value={content}
            spellCheck={false}
            aria-label="文件内容"
            onChange={(event) => setContent(event.target.value)}
          />
          {conflict && (
            <div className="rounded-lg border border-[var(--warn)]/40 bg-[var(--warn-soft)] p-3 text-sm text-[var(--warn)]">
              文件已被外部修改。重新加载会丢弃当前编辑；覆盖会以最新版本为基线保存。
              <div className="mt-2 flex gap-2">
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (conflict) {
                      setContent(conflict.content);
                      setMtime(conflict.mtime);
                    }
                    setConflict(null);
                  }}
                >
                  重新加载
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    if (conflict) save.mutate(conflict.mtime);
                  }}
                >
                  强制覆盖
                </Button>
              </div>
            </div>
          )}
          {error && <ErrorState message={error} />}
        </div>
      )}
    </Dialog>
  );
}
```

`apps/web/src/pages/instance/FilesTab.tsx`：

```tsx
import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { InstanceOutletContext } from '../../layouts/InstanceLayout';
import { FileBrowser } from '../../components/FileBrowser';
import { FileEditorDialog } from '../../components/FileEditorDialog';

export function FilesTab() {
  const { instance } = useOutletContext<InstanceOutletContext>();
  const [path, setPath] = useState('/');
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <FileBrowser instanceId={instance.id} path={path} onPathChange={setPath} onEdit={setEditing} />
      <FileEditorDialog
        instanceId={instance.id}
        path={editing}
        onOpenChange={(open) => (!open ? setEditing(null) : undefined)}
      />
    </div>
  );
}
```

`InstanceLayout` 的 `tabs` 增加 `{ to: 'files', label: '文件' }`，并让文件页签默认折叠右侧面板：

```ts
const collapsibleTabs = new Set(['files', 'config']);
```

在 `InstanceLayout` 内用 `useLocation()` 判断当前页签，若属于 `collapsibleTabs` 则初始 `rightOpen=false`（用户手动展开后不强制关闭，状态仍写 localStorage）。实现方式：在切换到这些页签时 `if (collapsibleTabs.has(tab)) setRightOpen(false)`，可放在导航点击处理或 `useEffect` 监听 `location.pathname`。

`router.tsx` 增加：

```tsx
import { FilesTab } from './pages/instance/FilesTab';
...
          <Route path="files" element={<FilesTab />} />
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -w @mcpanel/web -- test/file-browser.test.tsx && npm run typecheck -w @mcpanel/web`
Expected: 2 个测试 PASS。

- [ ] **Step 6: 提交**

```bash
npm run typecheck && npm test && npm run lint
git add apps/web/src apps/web/test
git commit -m "feat(web): add file browser with upload, unzip and mods toggle"
```

---

### Task 10: 配置页签（`server.properties` + EULA）

**Files:**
- Modify: `packages/shared/src/types.ts`（`PropertiesPayload` 增加 `eula`）
- Modify: `apps/server/src/routes/config.ts`（GET 返回 `eula`）
- Create: `apps/web/src/utils/properties.ts`
- Create: `apps/web/src/components/PropertiesForm.tsx`
- Create: `apps/web/src/pages/instance/ConfigTab.tsx`
- Modify: `apps/web/src/layouts/InstanceLayout.tsx`（页签）
- Modify: `apps/web/src/router.tsx`
- Test: `apps/web/test/properties-diff.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/web/test/properties-diff.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { diffProperties, parsePropertiesText } from '../src/utils/properties';

const RAW = '# comment\nmotd=Old\nserver-port=25565\nmotd=Old2\n\nview-distance=10\n';

describe('parsePropertiesText', () => {
  it('keeps duplicates and order', () => {
    const parsed = parsePropertiesText(RAW);
    expect(parsed.entries.map((entry) => entry.key)).toEqual(['motd', 'server-port', 'motd', 'view-distance']);
    expect(parsed.duplicates).toEqual(['motd']);
  });
});

describe('diffProperties', () => {
  it('returns only changed keys using the last occurrence', () => {
    const next = RAW.replace('motd=Old2', 'motd=New').replace('view-distance=10', 'view-distance=12');
    expect(diffProperties(RAW, next)).toEqual({ motd: 'New', 'view-distance': '12' });
    expect(diffProperties(RAW, RAW)).toEqual({});
  });

  it('ignores removed keys', () => {
    expect(diffProperties(RAW, 'server-port=25565\n')).toEqual({});
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/web -- test/properties-diff.test.ts`
Expected: FAIL，`utils/properties` 不存在。

- [ ] **Step 3: 实现解析/差分工具与纯函数**

`apps/web/src/utils/properties.ts`：

```ts
export interface WebPropertyEntry {
  key: string;
  value: string;
}

export function parsePropertiesText(raw: string): { entries: WebPropertyEntry[]; duplicates: string[] } {
  const entries: WebPropertyEntry[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!key) continue;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
    entries.push({ key, value: trimmed.slice(separator + 1).trim() });
  }
  return { entries, duplicates: [...duplicates] };
}

export function lastValue(entries: WebPropertyEntry[], key: string): string | undefined {
  let value: string | undefined;
  for (const entry of entries) if (entry.key === key) value = entry.value;
  return value;
}

export function diffProperties(before: string, after: string): Record<string, string> {
  const oldEntries = parsePropertiesText(before).entries;
  const newEntries = parsePropertiesText(after).entries;
  const changes: Record<string, string> = {};
  const oldKeys = new Set(oldEntries.map((entry) => entry.key));
  for (const key of oldKeys) {
    const previous = lastValue(oldEntries, key);
    const next = lastValue(newEntries, key);
    if (next !== undefined && next !== previous) changes[key] = next;
  }
  return changes;
}
```

- [ ] **Step 4: 实现表单与配置页签**

`apps/web/src/components/PropertiesForm.tsx`：

```tsx
import type { PropertiesPayload } from '@mcpanel/shared';
import { Field, Input, Select } from './ui';

type Value = string;

const BOOL_KEYS = new Set([
  'online-mode',
  'white-list',
  'enforce-whitelist',
  'hardcore',
  'pvp',
  'allow-flight',
  'force-gamemode',
  'enable-rcon',
  'enable-query',
  'allow-nether',
  'enable-command-block',
]);

const ENUM_OPTIONS: Record<string, Array<{ value: string; label: string }>> = {
  gamemode: [
    { value: 'survival', label: '生存' },
    { value: 'creative', label: '创造' },
    { value: 'adventure', label: '冒险' },
    { value: 'spectator', label: '旁观' },
  ],
  difficulty: [
    { value: 'peaceful', label: '和平' },
    { value: 'easy', label: '简单' },
    { value: 'normal', label: '普通' },
    { value: 'hard', label: '困难' },
  ],
};

const GROUPS: Array<{ title: string; fields: string[] }> = [
  { title: '基础', fields: ['motd', 'server-port', 'max-players', 'online-mode', 'white-list', 'enforce-whitelist'] },
  { title: '玩法', fields: ['gamemode', 'difficulty', 'hardcore', 'pvp', 'allow-flight', 'spawn-protection', 'force-gamemode'] },
  { title: '性能', fields: ['view-distance', 'simulation-distance', 'max-tick-time', 'entity-broadcast-range-percentage'] },
  { title: '网络', fields: ['server-ip', 'enable-rcon', 'rcon.port', 'rcon.password', 'enable-query', 'query.port'] },
  {
    title: '世界',
    fields: ['level-name', 'level-seed', 'level-type', 'allow-nether', 'enable-command-block', 'op-permission-level'],
  },
];

function initialValues(payload: PropertiesPayload): Record<string, Value> {
  const values: Record<string, Value> = {};
  for (const entry of payload.entries) values[entry.key] = entry.value;
  return values;
}

export function PropertiesForm({
  payload,
  values,
  onChange,
}: {
  payload: PropertiesPayload;
  values: Record<string, Value>;
  onChange: (next: Record<string, Value>) => void;
}) {
  const set = (key: string, value: string) => onChange({ ...values, [key]: value });
  const known = new Set(GROUPS.flatMap((group) => group.fields));

  return (
    <div className="flex flex-col gap-5">
      {payload.duplicates.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-[var(--warn)]">
          检测到重复键：{payload.duplicates.join('、')}。保存时会同时更新所有同名键。
        </div>
      )}
      {GROUPS.map((group) => (
        <section key={group.title} className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">{group.title}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {group.fields.map((key) => {
              const value = values[key] ?? '';
              const fieldId = `prop-${key.replaceAll('.', '-')}`;
              return (
                <Field key={key} label={key}>
                  {BOOL_KEYS.has(key) ? (
                    <Select value={value || 'false'} onChange={(event) => set(key, event.target.value)} aria-label={key}>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </Select>
                  ) : ENUM_OPTIONS[key] ? (
                    <Select value={value} onChange={(event) => set(key, event.target.value)} aria-label={key}>
                      {ENUM_OPTIONS[key]!.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}（{option.value}）
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      id={fieldId}
                      type={key === 'rcon.password' ? 'password' : 'text'}
                      value={value}
                      onChange={(event) => set(key, event.target.value)}
                      aria-label={key}
                    />
                  )}
                </Field>
              );
            })}
          </div>
        </section>
      ))}
      {payload.entries.filter((entry) => !known.has(entry.key)).length > 0 && (
        <p className="text-xs text-[var(--muted)]">
          其余 {payload.entries.filter((entry) => !known.has(entry.key)).length} 个字段未在表单中展示，可切换到原始编辑。
        </p>
      )}
      {JSON.stringify(values) !== JSON.stringify(initialValues(payload)) && (
        <p className="text-xs text-[var(--warn)]">修改将在保存后写入；多数配置需要重启服务器生效。</p>
      )}
    </div>
  );
}
```

`apps/web/src/pages/instance/ConfigTab.tsx`：

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { PropertiesPayload } from '@mcpanel/shared';
import type { InstanceOutletContext } from '../../layouts/InstanceLayout';
import { api, ApiError } from '../../api/client';
import { PropertiesForm } from '../../components/PropertiesForm';
import { RconEnableDialog } from '../../components/RconEnableDialog';
import { Button, ErrorState, Field, Notice, Spinner, toast } from '../../components/ui';
import { diffProperties } from '../../utils/properties';

export function ConfigTab() {
  const { instance } = useOutletContext<InstanceOutletContext>();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'form' | 'raw'>('form');
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [rawDraft, setRawDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enableOpen, setEnableOpen] = useState(false);

  const payload = useQuery({
    queryKey: ['properties', instance.id],
    queryFn: () => api.get<PropertiesPayload>(`/instances/${instance.id}/config/properties`),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['properties', instance.id] });
    setValues(null);
    setRawDraft(null);
  };

  const save = useMutation({
    mutationFn: (changes: Record<string, string>) =>
      api.put(`/instances/${instance.id}/config/properties`, {
        changes,
        expectedMtime: payload.data?.mtime ?? 0,
      }),
    onSuccess: async () => {
      setError(null);
      await refresh();
      toast('配置已保存，重启服务器后生效', 'success');
    },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : '保存失败'),
  });

  const acceptEula = useMutation({
    mutationFn: () => api.post(`/instances/${instance.id}/config/eula`, { accept: true }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['properties', instance.id] });
      toast('已接受 EULA', 'success');
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '操作失败', 'error'),
  });

  if (payload.isLoading) return <Spinner />;
  if (payload.isError || !payload.data) return <ErrorState message="配置加载失败" />;

  const data = payload.data;
  const current = values ?? Object.fromEntries(data.entries.map((entry) => [entry.key, entry.value]));
  const raw = rawDraft ?? data.raw;

  const saveForm = () => {
    const original = Object.fromEntries(data.entries.map((entry) => [entry.key, entry.value]));
    const changes: Record<string, string> = {};
    for (const [key, value] of Object.entries(current)) {
      if (original[key] !== value) changes[key] = value;
    }
    if (Object.keys(changes).length === 0) {
      toast('没有需要保存的修改', 'info');
      return;
    }
    save.mutate(changes);
  };

  const saveRaw = () => {
    const changes = diffProperties(data.raw, raw);
    if (Object.keys(changes).length === 0) {
      toast('没有需要保存的修改', 'info');
      return;
    }
    save.mutate(changes);
  };

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      {!data.eula && (
        <Notice tone="warning">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>尚未接受 Minecraft EULA，服务器启动会被拦截。</span>
            <Button variant="secondary" loading={acceptEula.isPending} onClick={() => acceptEula.mutate()}>
              接受 EULA
            </Button>
          </div>
        </Notice>
      )}
      {instance.rconStatus === 'disabled' && (
        <Notice tone="info">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>玩家管理需要 RCON。</span>
            <Button variant="secondary" onClick={() => setEnableOpen(true)}>
              启用 RCON
            </Button>
          </div>
        </Notice>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 rounded-lg border border-[var(--border)] p-0.5">
          <Button variant={mode === 'form' ? 'secondary' : 'ghost'} onClick={() => setMode('form')}>
            表单
          </Button>
          <Button variant={mode === 'raw' ? 'secondary' : 'ghost'} onClick={() => setMode('raw')}>
            原始编辑
          </Button>
        </div>
        <Button loading={save.isPending} onClick={() => (mode === 'form' ? saveForm() : saveRaw())}>
          保存配置
        </Button>
      </div>

      {mode === 'form' ? (
        <PropertiesForm payload={data} values={current} onChange={setValues} />
      ) : (
        <Field label="server.properties" hint="只保存值发生变化的键；注释、顺序与换行风格保持不变">
          <textarea
            aria-label="server.properties 内容"
            className="console-font h-96 w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--console-bg)] p-3 text-xs leading-5 text-[var(--console-fg)]"
            value={raw}
            spellCheck={false}
            onChange={(event) => setRawDraft(event.target.value)}
          />
        </Field>
      )}

      {error && <ErrorState message={error} />}

      <RconEnableDialog
        instanceId={instance.id}
        open={enableOpen}
        onOpenChange={setEnableOpen}
        onEnabled={() => {
          void queryClient.invalidateQueries({ queryKey: ['instances'] });
          void payload.refetch();
        }}
      />
    </div>
  );
}
```

`InstanceLayout` 的 `tabs` 增加 `{ to: 'config', label: '配置' }`；`router.tsx` 增加 `config` 路由。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -w @mcpanel/web -- test/properties-diff.test.ts && npm run typecheck`
Expected: 3 个测试 PASS。

- [ ] **Step 6: 提交**

```bash
npm run typecheck && npm test && npm run lint
git add packages/shared/src apps/server/src apps/web/src apps/web/test
git commit -m "feat: add server.properties form and raw editing with EULA acceptance"
```

---

### Task 11: 审计页

**Files:**
- Create: `apps/web/src/pages/AuditPage.tsx`
- Modify: `apps/web/src/layouts/AppShell.tsx`（侧边栏）
- Modify: `apps/web/src/router.tsx`
- Test: `apps/web/test/audit-page.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { AuditPage } from '../src/pages/AuditPage';

vi.mock('../src/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {},
  clearCsrfToken: vi.fn(),
  UNAUTHORIZED_EVENT: 'mcpanel:unauthorized',
}));

describe('AuditPage', () => {
  it('renders audit rows with action and target', async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        { id: '1', userId: 'u1', action: 'instance.start', targetType: 'instance', targetId: 'abc', detail: { at: 'x' }, ip: null, createdAt: '2026-10-24T00:00:00.000Z' },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AuditPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('instance.start')).toBeInTheDocument();
    expect(screen.getByText('abc')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/web -- test/audit-page.test.tsx`

- [ ] **Step 3: 实现审计页**

`apps/web/src/pages/AuditPage.tsx`：

```tsx
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { AuditEntry, Paginated } from '@mcpanel/shared';
import { api } from '../api/client';
import { Button, EmptyState, ErrorState, Input, Spinner } from '../components/ui';
import { formatDateTime } from '../utils/format';

const PAGE_SIZE = 20;

export function AuditPage() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [applied, setApplied] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['audit', page, applied],
    queryFn: () =>
      api.get<Paginated<AuditEntry>>(
        `/audit?page=${page}&pageSize=${PAGE_SIZE}${applied ? `&action=${encodeURIComponent(applied)}` : ''}`,
      ),
  });

  const total = query.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold">审计</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">所有写操作、登录与玩家动作都会记录在这里。</p>
      </div>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setApplied(action.trim());
        }}
      >
        <div className="w-64">
          <Input aria-label="动作过滤" placeholder="按动作前缀过滤，例如 instance." value={action} onChange={(event) => setAction(event.target.value)} />
        </div>
        <Button type="submit" variant="secondary">
          过滤
        </Button>
        {applied && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setAction('');
              setApplied('');
              setPage(1);
            }}
          >
            清除
          </Button>
        )}
      </form>

      {query.isLoading ? (
        <Spinner />
      ) : query.isError ? (
        <ErrorState message="审计记录加载失败" />
      ) : query.data && query.data.items.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="hidden grid-cols-[1fr_10rem_8rem_12rem] gap-3 border-b border-[var(--border)] px-4 py-2 text-xs text-[var(--muted)] md:grid">
            <span>动作</span>
            <span>对象</span>
            <span>来源 IP</span>
            <span>时间</span>
          </div>
          {query.data.items.map((entry) => (
            <div key={entry.id} className="border-b border-[var(--border)] last:border-0">
              <button
                type="button"
                className="grid w-full grid-cols-1 gap-1 px-4 py-2 text-left text-sm hover:bg-[var(--surface-2)] md:grid-cols-[1fr_10rem_8rem_12rem] md:gap-3"
                onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
              >
                <span className="font-medium">{entry.action}</span>
                <span className="truncate text-[var(--muted)]">{entry.targetId ?? entry.targetType}</span>
                <span className="text-[var(--muted)]">{entry.ip ?? '—'}</span>
                <span className="text-xs text-[var(--muted)]">{formatDateTime(entry.createdAt)}</span>
              </button>
              {expanded === entry.id && (
                <pre className="console-font overflow-auto border-t border-[var(--border)] bg-[var(--console-bg)] px-4 py-3 text-xs text-[var(--console-fg)]">
                  {JSON.stringify(entry.detail, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title="暂无审计记录" description={applied ? '没有匹配该前缀的记录。' : '完成一次写操作后这里会出现记录。'} />
      )}

      <div className="flex items-center justify-between text-sm text-[var(--muted)]">
        <span>
          共 {total} 条，第 {page} / {pages} 页
        </span>
        <div className="flex gap-2">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            上一页
          </Button>
          <Button variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            下一页
          </Button>
        </div>
      </div>
    </div>
  );
}
```

`AppShell` 的 `navigation` 增加：

```ts
  { to: '/audit', label: '审计', icon: ScrollText, end: true },
```

（`ScrollText` 来自 lucide。）

`router.tsx` 增加 `import { AuditPage } from './pages/AuditPage';` 与 `<Route path="audit" element={<AuditPage />} />`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @mcpanel/web -- test/audit-page.test.tsx`

- [ ] **Step 5: 提交**

```bash
npm run typecheck && npm test && npm run lint
git add apps/web/src apps/web/test
git commit -m "feat(web): add audit page with action prefix filtering"
```

---

### Task 12: 面板设置页（改密码 + 面板设置）

**Files:**
- Create: `apps/web/src/pages/SettingsPage.tsx`
- Modify: `apps/web/src/layouts/AppShell.tsx`（导航 + 面板名）
- Modify: `apps/web/src/router.tsx`
- Test: `apps/web/test/settings-page.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { SettingsPage } from '../src/pages/SettingsPage';

vi.mock('../src/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {},
  clearCsrfToken: vi.fn(),
  UNAUTHORIZED_EVENT: 'mcpanel:unauthorized',
}));

const settings = { panelName: 'MC Panel', defaultTimezone: 'Asia/Shanghai', auditRetentionDays: 90 };

afterEach(() => vi.clearAllMocks());

function renderPage() {
  (api.get as ReturnType<typeof vi.fn>).mockResolvedValue(settings);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SettingsPage />
    </QueryClientProvider>,
  );
}

describe('SettingsPage', () => {
  it('loads current settings and saves a change', async () => {
    (api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({ ...settings, panelName: '生存服' });
    renderPage();
    const name = await screen.findByLabelText('面板名称');
    const user = userEvent.setup();
    await user.clear(name);
    await user.type(name, '生存服');
    await user.click(screen.getByRole('button', { name: '保存面板设置' }));
    expect(api.patch).toHaveBeenCalledWith('/settings', expect.objectContaining({ panelName: '生存服' }));
  });

  it('requires two matching passwords before changing it', async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findByLabelText('当前密码');
    await user.type(screen.getByLabelText('当前密码'), 'old-password-123');
    await user.type(screen.getByLabelText('新密码'), 'new-password-123');
    await user.type(screen.getByLabelText('确认新密码'), 'mismatch-123');
    await user.click(screen.getByRole('button', { name: '修改密码' }));
    expect(api.post).not.toHaveBeenCalled();
    expect(await screen.findByText('两次输入的新密码不一致')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/web -- test/settings-page.test.tsx`

- [ ] **Step 3: 实现设置页**

`apps/web/src/pages/SettingsPage.tsx`：

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { PanelSettings } from '@mcpanel/shared';
import { api, ApiError } from '../api/client';
import { Button, ErrorState, Field, Input, Spinner, toast } from '../components/ui';

export function SettingsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<PanelSettings>('/settings') });
  const [form, setForm] = useState<PanelSettings | null>(null);
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const current = form ?? settings.data ?? null;

  const save = useMutation({
    mutationFn: (patch: PanelSettings) => api.patch<PanelSettings>('/settings', patch),
    onSuccess: async (next) => {
      queryClient.setQueryData(['settings'], next);
      setForm(null);
      toast('面板设置已保存', 'success');
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '保存失败', 'error'),
  });

  const changePassword = useMutation({
    mutationFn: () =>
      api.post('/auth/password', { currentPassword: passwords.currentPassword, newPassword: passwords.newPassword }),
    onSuccess: () => {
      setPasswords({ currentPassword: '', newPassword: '', confirm: '' });
      setPasswordError(null);
      toast('密码已修改，其他会话已退出', 'success');
    },
    onError: (cause) => setPasswordError(cause instanceof ApiError ? cause.message : '修改失败'),
  });

  const submitPassword = (event: FormEvent) => {
    event.preventDefault();
    setPasswordError(null);
    if (passwords.newPassword.length < 12) {
      setPasswordError('新密码至少 12 个字符');
      return;
    }
    if (passwords.newPassword !== passwords.confirm) {
      setPasswordError('两次输入的新密码不一致');
      return;
    }
    changePassword.mutate();
  };

  if (settings.isError) {
    return (
      <div className="p-8">
        <ErrorState message="面板设置加载失败" />
      </div>
    );
  }
  if (settings.isLoading || !current) {
    return (
      <div className="p-8">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">面板设置</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">面板名称、时区与审计保留策略</p>
      </div>

      <form
        className="flex flex-col gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(current);
        }}
      >
        <Field label="面板名称">
          <Input value={current.panelName} maxLength={60} onChange={(event) => setForm({ ...current, panelName: event.target.value })} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="默认时区" hint="例如 Asia/Shanghai">
            <Input value={current.defaultTimezone} onChange={(event) => setForm({ ...current, defaultTimezone: event.target.value })} />
          </Field>
          <Field label="审计保留天数" hint="1 到 3650 天；清理任务在阶段 3 接入">
            <Input
              type="number"
              min={1}
              max={3650}
              value={current.auditRetentionDays}
              onChange={(event) => setForm({ ...current, auditRetentionDays: Math.trunc(Number(event.target.value)) })}
            />
          </Field>
        </div>
        <div>
          <Button type="submit" loading={save.isPending}>
            保存面板设置
          </Button>
        </div>
      </form>

      <form
        className="flex flex-col gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"
        onSubmit={submitPassword}
      >
        <h2 className="font-semibold">修改密码</h2>
        <Field label="当前密码">
          <Input
            type="password"
            autoComplete="current-password"
            value={passwords.currentPassword}
            onChange={(event) => setPasswords({ ...passwords, currentPassword: event.target.value })}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="新密码" hint="至少 12 个字符">
            <Input
              type="password"
              autoComplete="new-password"
              value={passwords.newPassword}
              onChange={(event) => setPasswords({ ...passwords, newPassword: event.target.value })}
            />
          </Field>
          <Field label="确认新密码">
            <Input
              type="password"
              autoComplete="new-password"
              value={passwords.confirm}
              onChange={(event) => setPasswords({ ...passwords, confirm: event.target.value })}
            />
          </Field>
        </div>
        {passwordError && <ErrorState message={passwordError} />}
        <div>
          <Button type="submit" loading={changePassword.isPending} disabled={!passwords.currentPassword || !passwords.newPassword}>
            修改密码
          </Button>
        </div>
      </form>
    </div>
  );
}
```

> `PageSectionPlaceholder` 不存在——删掉这个 import，直接使用普通卡片即可。

`AppShell.tsx`：
- 侧边栏 `navigation` 追加（`audit` 已在 Task 11 加入）：

```ts
  { to: '/settings', label: '设置', icon: Settings, end: true },
```

- 面板名改为查询结果：

```tsx
import { useQuery } from '@tanstack/react-query';
import type { PanelSettings } from '@mcpanel/shared';
...
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<PanelSettings>('/settings') });
  const panelName = settings.data?.panelName ?? 'MC Panel';
```

把侧边栏与移动端顶栏里的 `MC Panel` 文本替换为 `{panelName}`。

`router.tsx` 增加 `import { SettingsPage } from './pages/SettingsPage';` 与 `<Route path="settings" element={<SettingsPage />} />`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @mcpanel/web -- test/settings-page.test.tsx`

- [ ] **Step 5: 提交**

```bash
npm run typecheck && npm test && npm run lint
git add apps/web/src apps/web/test
git commit -m "feat(web): add panel settings page and password change form"
```

---

### Task 13: 右侧玩家面板

**Files:**
- Create: `apps/web/src/components/InstanceRightPanel.tsx`
- Modify: `apps/web/src/layouts/InstanceLayout.tsx`
- Test: `apps/web/test/right-panel.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { InstanceRightPanel } from '../src/components/InstanceRightPanel';

vi.mock('../src/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {},
  clearCsrfToken: vi.fn(),
  UNAUTHORIZED_EVENT: 'mcpanel:unauthorized',
}));

describe('InstanceRightPanel', () => {
  it('shows the live player list and the RCON status', async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      online: ['Steve'],
      max: 20,
      warning: null,
      rconStatus: 'connected',
      state: 'running',
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <InstanceRightPanel
            instance={{ id: 'i1', rconStatus: 'connected' } as never}
            status={{ instanceId: 'i1', state: 'running', pid: 5, startedAt: null, exitCode: null, error: null }}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Steve')).toBeInTheDocument();
    expect(screen.getByText('已连接')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

- [ ] **Step 3: 实现右侧面板**

`apps/web/src/components/InstanceRightPanel.tsx`：

```tsx
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { InstanceInfo, InstanceStatusSnapshot, PlayersResponse } from '@mcpanel/shared';
import { api } from '../api/client';
import { StatusBadge } from './StatusBadge';
import { Spinner } from './ui';
import { PlayerAvatar } from './PlayerAvatar';
import { RCON_LABELS } from '../utils/labels';

export function InstanceRightPanel({ instance, status }: { instance: InstanceInfo; status: InstanceStatusSnapshot }) {
  const players = useQuery({
    queryKey: ['players', instance.id],
    queryFn: () => api.get<PlayersResponse>(`/instances/${instance.id}/players`),
    refetchInterval: 15_000,
  });
  const online = players.data?.online ?? [];

  return (
    <div className="sticky top-4 flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm">
      <div className="font-medium">运行状态</div>
      <div className="flex justify-between gap-3 text-[var(--muted)]">
        <span>状态</span>
        <StatusBadge state={status.state} />
      </div>
      <div className="flex justify-between gap-3 text-[var(--muted)]">
        <span>PID</span>
        <span className="tabular-nums">{status.pid ?? '—'}</span>
      </div>
      <div className="flex justify-between gap-3 text-[var(--muted)]">
        <span>RCON</span>
        <span>{RCON_LABELS[players.data?.rconStatus ?? instance.rconStatus]}</span>
      </div>

      <div className="border-t border-[var(--border)] pt-3">
        <div className="flex items-center justify-between text-[var(--muted)]">
          <span>在线玩家</span>
          <span className="tabular-nums">
            {online.length} / {players.data?.max ?? 0}
          </span>
        </div>
        <div className="mt-2 flex flex-col gap-1.5">
          {online.slice(0, 8).map((name) => (
            <div key={name} className="flex items-center gap-2">
              <PlayerAvatar name={name} size={20} />
              <span className="truncate">{name}</span>
            </div>
          ))}
          {online.length === 0 && (
            <span className="text-xs text-[var(--muted)]">{players.isLoading ? '加载中…' : '暂无在线玩家'}</span>
          )}
        </div>
      </div>

      {status.error && <div className="rounded-md bg-red-500/10 p-2 text-xs text-[var(--danger)]">{status.error}</div>}

      <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-3">
        <Link to="players" className="text-[var(--primary)] hover:underline">
          玩家管理 →
        </Link>
        <Link to="console" className="text-[var(--primary)] hover:underline">
          打开控制台 →
        </Link>
      </div>
    </div>
  );
}
```

> `InstanceLayout` 里原有的一段 aside 替换为：

```tsx
        {rightOpen && (
          <aside className="hidden w-72 shrink-0 lg:block">
            <InstanceRightPanel instance={instance} status={status} />
          </aside>
        )}
```

并删除不再使用的 `RCON_LABELS`/`Spinner` 等 import（以 lint 结果为准）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @mcpanel/web -- test/right-panel.test.tsx`

- [ ] **Step 5: 提交**

```bash
npm run typecheck && npm test && npm run lint
git add apps/web/src apps/web/test
git commit -m "feat(web): show live players in the instance side panel"
```

---

### Task 14: 阶段 2 验收与文档

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/HANDOFF-phase1.md`（追加阶段 2 记录，或改名引用）
- Test: 手工验收 + 全量命令

- [ ] **Step 1: 全量自动化校验**

```bash
npm run typecheck
npm test
npm run lint
npm run build
```

Expected：typecheck 0 错误；server/web/shared 测试全绿；lint 无 error；构建产出 `apps/server/dist/index.js` 与 `apps/web/dist/index.html`。

- [ ] **Step 2: 手工验收矩阵（生产构建 + 假服务端目录）**

```bash
DATA_DIR=./data-dev PANEL_PORT=3123 npm start
```

用 `test/fixtures/fake-server.mjs` 建一个目录（`eula.txt`、`server.properties`、`start.bat`），逐项确认：

- [ ] 纳管后进入「玩家」页：RCON 显示未启用，点「启用 RCON」→ 弹窗显示端口与 16 位密码，`server.properties` 出现 `enable-rcon=true`，重启服务器后玩家页显示「RCON：已连接」。
- [ ] 通过真实 RCON 或假 RCON 看到在线玩家；执行 OP/白名单/踢出，审计页出现 `player.*` 记录。
- [ ] 文件页：新建目录、上传一个文件、重命名、下载、删除（目录需输入名称）、解压 zip、在 `mods/` 下禁用/启用 `.jar`。
- [ ] 打开文本文件编辑并保存；在外部修改同一文件后再保存 → 出现冲突提示，可「重新加载」或「强制覆盖」。
- [ ] 配置页：修改 `motd` 与 `max-players`，保存后文件里注释与顺序不变、CRLF 保持；原始编辑保存只改值。
- [ ] 未接受 EULA 的实例显示警告，点「接受 EULA」后 `eula.txt` 变为 `eula=true`，审计出现 `instance.eula_accept`。
- [ ] 审计页按 `player.` 前缀过滤生效；翻页正常。
- [ ] 设置页修改面板名后侧边栏立即更新；修改密码后其他浏览器会话被踢出，当前会话仍可用。
- [ ] 1280px 与 375px 宽度下玩家/文件/配置页可用，右侧面板在文件/配置页默认折叠。

- [ ] **Step 3: 更新文档**

`README.md`：
- 「当前阶段」改为阶段 2 已完成，列出玩家管理、文件、配置、EULA、审计、面板设置；
- 「忘记密码」改为指向「设置 → 修改密码」；
- 数据目录说明补一句 `mods/` 与文件操作均在实例目录内完成；
- 安全章节补：文件写入经过沙箱、解压校验 zip-slip 与体积上限、玩家动作使用固定命令模板。

`docs/superpowers/plans/handoff`：新增 `HANDOFF-phase2.md`（或在本计划末尾追加「执行记录」），记录：实际提交、偏差（见下）、已知问题（CodeMirror 未引入、批量删除未做、审计保留策略未接入清理任务）。

- [ ] **Step 4: 提交**

```bash
git add README.md docs/superpowers/plans
git commit -m "docs: record phase 2 scope, acceptance and known gaps"
```

---

## 阶段 2 规格覆盖对照

| 规格章节 | 任务 |
| --- | --- |
| §10.1–10.2 RCON 配置与状态 | 阶段 1 已完成；Task 4 增加状态读取路由 |
| §10.3 一键启用 RCON | Task 5、Task 8 |
| §10.4 在线玩家（含解析与刷新） | Task 6、Task 8、Task 13 |
| §10.5 玩家操作与只读名单 | Task 6、Task 8 |
| §10.6 命令发送 | 阶段 1 已完成 |
| §11.1 路径沙箱 | 阶段 1 已完成；Task 2 复核写入路径 |
| §11.2 文件列表/读写/上传/下载/新建/重命名/删除/解压 | Task 2、Task 3、Task 9 |
| §11.3 模组启停 | Task 3、Task 9 |
| §11.4 `server.properties` 表单与原始编辑 | Task 4、Task 10 |
| §11.5 EULA | Task 4、Task 10 |
| §16.4 `/api/settings` | Task 7、Task 12 |
| §16.6 玩家与 RCON API | Task 5、Task 6 |
| §16.7 文件与配置 API | Task 2、Task 3、Task 4 |
| §18.1 路由（players/files/config/audit/settings） | Task 8–13 |
| §18.2 右侧玩家面板 | Task 13 |
| §18.4 PlayerList/FileBrowser/FileEditor/PropertiesForm | Task 8–10（编辑器用 textarea，见偏差） |
| §18.5 状态管理（Query/Zustand/401） | 各前端任务复用阶段 1 约定 |
| §18.7 错误与空状态 | 各前端任务 |
| §22 阶段 2 验收 | Task 14 |

## 计划自审记录

- **执行顺序**：Task 1–7 是后端，每个任务自带集成测试；Task 8–13 是前端，Task 14 才做整体验收。后端任务之间没有循环依赖：Task 2 的 `FileService` 独立；Task 3 扩它；Task 4 用 `sandbox` 与 `writeFileAtomic`；Task 5 复用 `properties-patch`；Task 6 复用 `RconService`；Task 7 独立。
- **与规格的有意偏差**：
  1. 文件编辑器用 `<textarea>` 而不是 CodeMirror 6：满足编辑与冲突处理需求，避免再引入约 300 kB 依赖；阶段 3 打磨时若需要语法高亮再替换，接口不变。
  2. 原始编辑通过客户端 `diffProperties` 换算成 `changes` 提交，因此**只支持改值与追加**，不支持通过原始编辑删除键；界面需在 Task 10 的提示里说明。
  3. 上传使用 `MAX_UPLOAD_MB` 作为单文件与整体限制；`@fastify/multipart` 的 `fileSize` 超限时以 413 返回。
  4. 解压仅支持 zip，且要求目标目录已存在（界面默认当前目录），不自动创建多级目标。
  5. 一键启用 RCON 的端口冲突只检查「其他受管实例的配置」，不检查操作系统端口占用（规格原文如此）；实际连接失败会由状态显示暴露。
  6. 玩家动作全部走 RCON（规格 §10.5），不退回 stdin；RCON 不可用时直接报错，避免命令语义不一致。
- **类型一致性**：`FileEntryInfo`、`FileListResult`、`TextFileContent`、`PlayersResponse`、`PlayerListsResponse`、`PropertiesPayload`、`PanelSettings` 在 Task 1 定义，后续任务只引用；`RconEnableResult` 出现在 Task 1 类型与 Task 5 返回值。
- **占位符扫描**：计划中没有 TBD/TODO；每个代码块都是完整实现。测试中的 `as never`/`as unknown as` 只用于构造最小依赖桩。
- **风险**：`yauzl` 的回调流程较长，执行时优先让集成测试覆盖 zip-slip、符号链接条目与体积上限；上传临时文件必须在校验失败时清理（Task 3 的 `catch` 已包含）。

