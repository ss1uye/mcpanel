# 阶段 3（备份、计划任务与部署打磨）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在阶段 1–2 的面板上补齐严格一致的备份/恢复、定时任务、备份与计划 UI、Windows/Linux 部署脚本与 Playwright 冒烟，完成第一版的全部交付。

**Architecture:** 备份由 `BackupService` 串起「源规划 → 严格冻结 → 流式打包 → 原子落盘 → 保留策略」，恢复由 `RestoreService` 以「pre_restore 冷备份 → 安全解压 → rollback 交换 → 失败回滚」实现；长任务通过 `TaskTracker` 产生 `TaskInfo`，经现有 WS `task:<taskId>` 频道推送。定时任务用 `croner` 按实例计划调度，动作复用 supervisor 与备份服务。

**Tech Stack:** Fastify 5、archiver、croner、yauzl、better-sqlite3 + drizzle、zod、React 19、TanStack Query 5、Zustand 5、Playwright（Chromium）。

---

## 阶段边界

只做规格 §22「阶段 3」：备份/恢复、计划任务、运行记录、Windows `start-panel.bat`、systemd 文档、`reset-password.mjs`、Playwright 冒烟。不新增玩家/文件/配置能力。

## 关键决策（与规格的偏差，执行时以本计划为准）

1. **任务进度用 WS `task:<taskId>` 频道**（规格 §17 已预留该频道，Phase 1 的 hub 目前对其返回 403）。备份/恢复创建后返回 `202 {taskId, backupId}`，前端订阅该频道显示进度；任务注册表在内存中保留 1 小时。
2. **备份 zip 写入 `manifest.json` 作为第一个条目**，恢复时先读取并校验 `schemaVersion === 1`。
3. **恢复使用共享的 `extractZipSafe`**（从 `FileService.unzip` 抽出），同时服务文件页与恢复流程，避免两份 zip-slip 实现。
4. **计划任务的「立即运行」同步等待结果**（返回 200 + `ScheduleRunInfo`）；自然触发在后台跑。这样 UI 不需要额外的任务通道也能显示手动运行结果。
5. **面板离线不补跑**：调度器启动时只排未来的触发点，`croner` 默认行为已满足。
6. **备份列表轮询兜底**：前端在没有任务通道（WS 断开）时仍可通过刷新列表看到 `creating`/`restoring` 状态；不做服务端轮询接口。

## 文件结构

```text
packages/shared/src/
├─ types.ts                  # + BackupInfo/BackupManifest/ScheduleInfo/ScheduleRunInfo/TaskInfo
├─ constants.ts              # + SCHEDULE_ACTIONS、BACKUP_KINDS、TASK_KINDS
├─ errors.ts                 # 已有 BACKUP_* / INVALID_CRON，无需新增
└─ schemas/automation.ts     # 新增：备份确认、计划创建/更新、payload 校验

apps/server/src/
├─ utils/zip-extract.ts      # 新增：安全解压（zip-slip/符号链接/条目数与体积上限）
├─ services/
│  ├─ backup-sources.ts      # 新增：备份源规划（纯逻辑 + 目录遍历）
│  ├─ backup-archive.ts      # 新增：archiver 打包 + manifest + 进度回调
│  ├─ backup-consistency.ts  # 新增：save-off / save-all flush / 等待日志 / save-on
│  ├─ backup-service.ts      # 新增：创建、保留策略、列表、删除、启动恢复
│  ├─ restore-service.ts     # 新增：pre_restore、安全解压、rollback、清理残留
│  ├─ schedule-service.ts    # 新增：croner 校验/调度/执行/运行记录
│  ├─ task-tracker.ts        # 新增：TaskInfo 生命周期与订阅
│  └─ file-service.ts        # 修改：unzip 改用 extractZipSafe
├─ routes/
│  ├─ backups.ts             # 新增：/api/instances/:id/backups*
│  ├─ schedules.ts           # 新增：/api/instances/:id/schedules*
│  └─ instances.ts           # 修改：cleanup-restore 动作
├─ ws/hub.ts                 # 修改：支持 task:<id> 订阅与 task.update 推送
├─ app.ts                    # 修改：注册新路由
└─ index.ts                  # 修改：构造服务、恢复中断记录、启动/停止调度器

apps/web/src/
├─ stores/realtime.ts        # 修改：tasks 切片 + useTask
├─ components/
│  ├─ BackupList.tsx         # 新增
│  ├─ ScheduleForm.tsx       # 新增
│  └─ TaskProgress.tsx       # 新增
├─ pages/instance/
│  ├─ BackupsTab.tsx         # 新增
│  ├─ SchedulesTab.tsx       # 新增
│  └─ OverviewTab.tsx        # 修改：rollback 残留警告 + 清理
├─ layouts/InstanceLayout.tsx# 修改：备份/计划页签
└─ router.tsx                # 修改：路由

scripts/
├─ start-panel.bat           # 新增
└─ reset-password.mjs        # 新增
docs/systemd.md              # 新增
e2e/                         # 新增：Playwright 冒烟
```

## 约定

- 备份文件固定放在 `data/backups/<instanceId>/<filename>`；打包临时文件放在 `data/tmp/`。
- 备份/恢复/计划触发的动作都记审计：`backup.create`、`backup.delete`、`backup.restore`、`backup.restore_failed`、`schedule.create/update/delete/run`。
- 实例内临时目录统一 `.mcpanel-tmp/`（`restore-<uuid>`、`rollback-<uuid>`、上传临时文件），文件浏览与备份都会排除它。
- 每个任务结束：`npm run typecheck && npm test && npm run lint` 全绿再提交。

---

### Task 1: 共享契约（备份、计划、任务）

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/constants.ts`
- Create: `packages/shared/src/schemas/automation.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/schemas/ws.ts`（任务消息）
- Test: `packages/shared/test/schemas.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/shared/test/schemas.test.ts` 顶部补充 import：

```ts
import { createScheduleSchema, updateScheduleSchema, restoreBackupSchema } from '../src/schemas/automation';
```

在文件末尾追加：

```ts
describe('phase 3 schemas', () => {
  it('requires a payload for command and broadcast schedules', () => {
    expect(() =>
      createScheduleSchema.parse({ name: '每日备份', cron: '0 4 * * *', timezone: 'Asia/Shanghai', actionType: 'backup' }),
    ).not.toThrow();
    expect(() =>
      createScheduleSchema.parse({ name: '广播', cron: '0 9 * * *', timezone: 'Asia/Shanghai', actionType: 'broadcast' }),
    ).toThrow();
    expect(
      createScheduleSchema.parse({
        name: '广播',
        cron: '0 9 * * *',
        timezone: 'Asia/Shanghai',
        actionType: 'broadcast',
        message: '早上好',
      }),
    ).toMatchObject({ message: '早上好', enabled: true });
    expect(() =>
      createScheduleSchema.parse({ name: '命令', cron: '*/5 * * * *', timezone: 'Asia/Shanghai', actionType: 'command' }),
    ).toThrow();
  });

  it('validates partial schedule updates and restore confirmation', () => {
    expect(updateScheduleSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(() => updateScheduleSchema.parse({})).toThrow();
    expect(() => restoreBackupSchema.parse({})).toThrow();
    expect(restoreBackupSchema.parse({ confirm: true })).toEqual({ confirm: true });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/shared`
Expected: FAIL，`schemas/automation` 不存在。

- [ ] **Step 3: 实现类型、常量与 schema**

`packages/shared/src/constants.ts` 追加：

```ts
export const BACKUP_KINDS = ['manual', 'scheduled', 'pre_restore'] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];
export const BACKUP_STATUSES = ['creating', 'ready', 'failed', 'restoring'] as const;
export type BackupStatus = (typeof BACKUP_STATUSES)[number];
export const SCHEDULE_ACTIONS = ['backup', 'start', 'stop', 'restart', 'command', 'broadcast'] as const;
export type ScheduleActionType = (typeof SCHEDULE_ACTIONS)[number];
export const SCHEDULE_RUN_STATUSES = ['running', 'success', 'failed', 'skipped'] as const;
export type ScheduleRunStatus = (typeof SCHEDULE_RUN_STATUSES)[number];
```

`packages/shared/src/types.ts` 追加（并把 `ScheduleActionType`/`BackupKind` 等加入 import）：

```ts
export interface BackupManifest {
  schemaVersion: 1;
  panelVersion: string;
  instanceName: string;
  createdAt: string;
  sources: string[];
  fileCount: number;
  totalBytes: number;
}

export interface BackupInfo {
  id: string;
  instanceId: string;
  filename: string;
  kind: BackupKind;
  status: BackupStatus;
  sizeBytes: number | null;
  includesMods: boolean;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ScheduleInfo {
  id: string;
  instanceId: string;
  name: string;
  cron: string;
  timezone: string;
  actionType: ScheduleActionType;
  command: string | null;
  message: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

export interface ScheduleRunInfo {
  id: string;
  scheduleId: string;
  trigger: 'scheduled' | 'manual';
  status: ScheduleRunStatus;
  message: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface TaskInfo {
  id: string;
  kind: 'backup' | 'restore';
  instanceId: string;
  status: 'running' | 'success' | 'failed';
  progress: number;
  message: string | null;
  startedAt: string;
  finishedAt: string | null;
}
```

`ServerWsMessage` 联合类型追加：

```ts
  | { type: 'task.update'; task: TaskInfo }
```

`packages/shared/src/schemas/ws.ts`：客户端消息里允许 `subscribe` 到 `task:<uuid>`（`WS_CHANNEL_PATTERN` 已包含），无需改动；如果该文件对 `channel` 有额外枚举校验，补上任务频道。

`packages/shared/src/schemas/automation.ts`：

```ts
import { z } from 'zod';
import { SCHEDULE_ACTIONS } from '../constants';

const timezone = z
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

const command = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine((value) => !/[\r\n]/.test(value), '命令不能包含换行');
const message = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !/[\r\n]/.test(value), '消息不能包含换行');

export const createScheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    cron: z.string().trim().min(1).max(120),
    timezone,
    actionType: z.enum(SCHEDULE_ACTIONS),
    command: command.optional(),
    message: message.optional(),
    enabled: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.actionType === 'command' && value.command === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['command'], message: 'command 动作需要命令内容' });
    }
    if (value.actionType === 'broadcast' && value.message === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['message'], message: 'broadcast 动作需要广播内容' });
    }
  });

export const updateScheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    cron: z.string().trim().min(1).max(120),
    timezone,
    actionType: z.enum(SCHEDULE_ACTIONS),
    command: command.nullable(),
    message: message.nullable(),
    enabled: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个要修改的字段' });

export const restoreBackupSchema = z.object({ confirm: z.literal(true) });
```

`packages/shared/src/index.ts` 追加 `export * from './schemas/automation';`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @mcpanel/shared`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/shared
git commit -m "feat(shared): add backup, schedule and task contracts"
```

---

### Task 2: 备份源规划

**Files:**
- Create: `apps/server/src/services/backup-sources.ts`
- Test: `apps/server/test/unit/backup-sources.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planBackupSources, DEFAULT_EXCLUDES } from '../../src/services/backup-sources';
import { AppError } from '../../src/utils/errors';

const roots: string[] = [];

async function fixtures() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-sources-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'world', 'region'), { recursive: true });
  await fs.writeFile(path.join(root, 'world', 'level.dat'), 'level');
  await fs.writeFile(path.join(root, 'world', 'region', 'r.0.0.mca'), 'region');
  await fs.mkdir(path.join(root, 'world_nether'));
  await fs.writeFile(path.join(root, 'world_nether', 'level.dat'), 'nether');
  await fs.mkdir(path.join(root, 'config'));
  await fs.writeFile(path.join(root, 'config', 'a.yml'), 'a');
  await fs.mkdir(path.join(root, 'mods'));
  await fs.writeFile(path.join(root, 'mods', 'a.jar'), 'jar');
  await fs.mkdir(path.join(root, 'logs'));
  await fs.writeFile(path.join(root, 'logs', 'latest.log'), 'log');
  await fs.mkdir(path.join(root, 'cache'));
  await fs.writeFile(path.join(root, 'cache', 'x'), 'x');
  await fs.mkdir(path.join(root, '.mcpanel-tmp'));
  await fs.writeFile(path.join(root, '.mcpanel-tmp', 'tmp'), 'tmp');
  await fs.writeFile(path.join(root, 'server.properties'), 'motd=hi');
  await fs.writeFile(path.join(root, 'eula.txt'), 'eula=true');
  await fs.writeFile(path.join(root, 'whitelist.json'), '[]');
  await fs.mkdir(path.join(root, 'plugins'));
  await fs.writeFile(path.join(root, 'plugins', 'extra.txt'), 'extra');
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('planBackupSources', () => {
  it('collects world, config and metadata while skipping excluded directories', async () => {
    const root = await fixtures();
    const plan = await planBackupSources(root, {
      levelName: 'world',
      includeMods: false,
      includeConfig: true,
      extraPaths: ['plugins'],
    });
    expect(plan.sources).toEqual(
      expect.arrayContaining(['world', 'world_nether', 'config', 'server.properties', 'eula.txt', 'whitelist.json', 'plugins']),
    );
    expect(plan.sources).not.toContain('logs');
    expect(plan.sources).not.toContain('cache');
    expect(plan.sources).not.toContain('.mcpanel-tmp');
    expect(plan.sources).not.toContain('mods');
    expect(plan.fileCount).toBeGreaterThanOrEqual(8);
    expect(plan.totalBytes).toBeGreaterThan(0);
  });

  it('includes mods only when asked and skips missing optional paths', async () => {
    const root = await fixtures();
    const plan = await planBackupSources(root, {
      levelName: 'world',
      includeMods: true,
      includeConfig: false,
      extraPaths: ['missing', 'plugins/extra.txt'],
    });
    expect(plan.sources).toContain('mods');
    expect(plan.sources).not.toContain('config');
    expect(plan.skippedMissing).toEqual(['missing']);
    expect(plan.sources).not.toContain('mods/a.jar');
  });

  it('rejects when there is nothing to back up', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-empty-'));
    roots.push(root);
    await expect(
      planBackupSources(root, { levelName: 'world', includeMods: false, includeConfig: false, extraPaths: [] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(DEFAULT_EXCLUDES).toContain('logs');
  });

  it('refuses extra paths that escape the instance root', async () => {
    const root = await fixtures();
    await expect(
      planBackupSources(root, { levelName: 'world', includeMods: false, includeConfig: false, extraPaths: ['../outside'] }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/server -- test/unit/backup-sources.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现备份源规划**

`apps/server/src/services/backup-sources.ts`：

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../utils/errors';

export const DEFAULT_EXCLUDES = ['logs', 'crash-reports', 'cache', 'libraries', '.mcpanel-tmp'] as const;
const MAX_EXTRA_PATHS = 20;

export interface BackupSourceOptions {
  levelName: string;
  includeMods: boolean;
  includeConfig: boolean;
  extraPaths: string[];
}

export interface BackupSourcePlan {
  sources: string[];
  fileCount: number;
  totalBytes: number;
  skippedMissing: string[];
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function isExcluded(rel: string): boolean {
  const segments = rel.split('/');
  return segments.some((segment) => (DEFAULT_EXCLUDES as readonly string[]).includes(segment));
}

function normalizeExtra(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized || normalized.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) {
    throw new AppError('VALIDATION_ERROR', `备份附加路径非法：${value}`);
  }
  return normalized;
}

async function walk(root: string, rel: string, acc: { fileCount: number; totalBytes: number }): Promise<void> {
  const absolute = path.join(root, ...rel.split('/'));
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(absolute)) {
      const childRel = `${rel}/${entry}`;
      if (isExcluded(childRel)) continue;
      await walk(root, childRel, acc);
    }
    return;
  }
  if (stat.isFile()) {
    acc.fileCount += 1;
    acc.totalBytes += stat.size;
  }
}

export async function planBackupSources(root: string, options: BackupSourceOptions): Promise<BackupSourcePlan> {
  if (options.extraPaths.length > MAX_EXTRA_PATHS) {
    throw new AppError('VALIDATION_ERROR', `备份附加路径最多 ${MAX_EXTRA_PATHS} 个`);
  }
  const candidates = [
    options.levelName,
    `${options.levelName}_nether`,
    `${options.levelName}_the_end`,
    'server.properties',
    'eula.txt',
    'whitelist.json',
    'ops.json',
    'banned-players.json',
    'banned-ips.json',
    ...(options.includeConfig ? ['config', 'defaultconfigs'] : []),
    ...(options.includeMods ? ['mods'] : []),
    ...options.extraPaths.map(normalizeExtra),
  ];

  const sources: string[] = [];
  const skippedMissing: string[] = [];
  const seen = new Set<string>();
  const totals = { fileCount: 0, totalBytes: 0 };

  for (const candidate of candidates) {
    if (seen.has(candidate) || isExcluded(candidate)) continue;
    seen.add(candidate);
    const absolute = path.join(root, ...candidate.split('/'));
    const stat = await fs.lstat(absolute).catch(() => null);
    if (!stat) {
      skippedMissing.push(candidate);
      continue;
    }
    if (stat.isSymbolicLink()) {
      throw new AppError('SYMLINK_NOT_ALLOWED', `备份源包含符号链接：${candidate}`);
    }
    sources.push(candidate);
    await walk(root, candidate, totals);
  }

  if (totals.fileCount === 0) {
    throw new AppError('VALIDATION_ERROR', '没有可备份的内容');
  }
  return { sources, fileCount: totals.fileCount, totalBytes: totals.totalBytes, skippedMissing };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @mcpanel/server -- test/unit/backup-sources.test.ts`
Expected: 4 个测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src apps/server/test
git commit -m "feat(server): plan backup sources with exclusions and limits"
```

---

### Task 3: 安全解压工具与备份打包

**Files:**
- Create: `apps/server/src/utils/zip-extract.ts`
- Modify: `apps/server/src/services/file-service.ts`（unzip 改用它）
- Create: `apps/server/src/services/backup-archive.ts`
- Modify: `apps/server/package.json`（新增 `archiver`、`@types/archiver`）
- Test: `apps/server/test/unit/zip-extract.test.ts`
- Test: `apps/server/test/unit/backup-archive.test.ts`

- [ ] **Step 1: 安装依赖**

```bash
npm install archiver -w @mcpanel/server
npm install -D @types/archiver -w @mcpanel/server
```

- [ ] **Step 2: 写失败测试**

`apps/server/test/unit/zip-extract.test.ts`：

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { extractZipSafe } from '../../src/utils/zip-extract';

const dirs: string[] = [];

function makeZip(files: Record<string, string>, symlinks: string[] = []): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(text, 'utf8');
    const data = deflateRawSync(raw);
    const crc = crc32(raw) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);

    const isLink = symlinks.includes(name);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x031e, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE((isLink ? 0o120777 : 0o100644) << 16, 38);
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

async function withZip(files: Record<string, string>, symlinks: string[] = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-zip-'));
  dirs.push(dir);
  const archive = path.join(dir, 'a.zip');
  await fs.writeFile(archive, makeZip(files, symlinks));
  return { archive, out: path.join(dir, 'out') };
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('extractZipSafe', () => {
  it('extracts nested files', async () => {
    const { archive, out } = await withZip({ 'config/a.txt': 'hello', 'b.txt': 'b' });
    const result = await extractZipSafe(archive, out);
    expect(result.entries).toBe(2);
    expect(await fs.readFile(path.join(out, 'config', 'a.txt'), 'utf8')).toBe('hello');
  });

  it('rejects traversal, absolute and symlink entries', async () => {
    const traversal = await withZip({ '../escape.txt': 'x' });
    await expect(extractZipSafe(traversal.archive, traversal.out)).rejects.toMatchObject({ code: 'ZIP_INVALID' });

    const absolute = await withZip({ '/abs.txt': 'x' });
    await expect(extractZipSafe(absolute.archive, absolute.out)).rejects.toMatchObject({ code: 'ZIP_INVALID' });

    const link = await withZip({ link: 'target' }, ['link']);
    await expect(extractZipSafe(link.archive, link.out)).rejects.toMatchObject({ code: 'ZIP_INVALID' });
  });

  it('enforces entry and byte limits', async () => {
    const many = await withZip({ 'a.txt': 'a', 'b.txt': 'b' });
    await expect(extractZipSafe(many.archive, many.out, { maxEntries: 1 })).rejects.toMatchObject({
      code: 'ZIP_INVALID',
    });

    const big = await withZip({ 'big.bin': 'x'.repeat(2048) });
    await expect(extractZipSafe(big.archive, big.out, { maxBytes: 1024 })).rejects.toMatchObject({
      code: 'ZIP_INVALID',
    });
  });
});
```

`apps/server/test/unit/backup-archive.test.ts`：

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeBackupArchive } from '../../src/services/backup-archive';
import { extractZipSafe } from '../../src/utils/zip-extract';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('writeBackupArchive', () => {
  it('writes manifest first and includes sources without excluded directories', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-archive-'));
    dirs.push(dir);
    const root = path.join(dir, 'server');
    await fs.mkdir(path.join(root, 'world'), { recursive: true });
    await fs.writeFile(path.join(root, 'world', 'level.dat'), 'level');
    await fs.mkdir(path.join(root, 'logs'));
    await fs.writeFile(path.join(root, 'logs', 'latest.log'), 'log');
    await fs.writeFile(path.join(root, 'server.properties'), 'motd=hi');

    const archive = path.join(dir, 'backup.zip');
    const manifest = {
      schemaVersion: 1 as const,
      panelVersion: '0.1.0',
      instanceName: '生存服',
      createdAt: '2026-10-24T00:00:00.000Z',
      sources: ['world', 'server.properties'],
      fileCount: 2,
      totalBytes: 12,
    };
    const progress: number[] = [];
    const bytes = await writeBackupArchive({
      root,
      sources: ['world', 'server.properties', 'logs'],
      destination: archive,
      manifest,
      onProgress: (value) => progress.push(value),
    });
    expect(bytes).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe(1);

    const out = path.join(dir, 'out');
    await extractZipSafe(archive, out);
    const written = JSON.parse(await fs.readFile(path.join(out, 'manifest.json'), 'utf8'));
    expect(written).toMatchObject({ schemaVersion: 1, instanceName: '生存服' });
    expect(await fs.readFile(path.join(out, 'world', 'level.dat'), 'utf8')).toBe('level');
    expect(await fs.readFile(path.join(out, 'server.properties'), 'utf8')).toBe('motd=hi');
    await expect(fs.stat(path.join(out, 'logs', 'latest.log'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test -w @mcpanel/server -- test/unit/zip-extract.test.ts test/unit/backup-archive.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现安全解压并让 FileService 复用它**

`apps/server/src/utils/zip-extract.ts`：

```ts
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { AppError } from './errors';

export interface ExtractLimits {
  maxEntries?: number;
  maxBytes?: number;
}

export interface ExtractResult {
  entries: number;
  bytes: number;
}

function unsafeEntry(name: string): boolean {
  const normalized = name.replaceAll('\\', '/');
  return (
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..') ||
    normalized.includes('\0')
  );
}

export async function extractZipSafe(
  archivePath: string,
  destinationDir: string,
  limits: ExtractLimits = {},
): Promise<ExtractResult> {
  const maxEntries = limits.maxEntries ?? 100_000;
  const maxBytes = limits.maxBytes ?? 10 * 1024 * 1024 * 1024;
  await fs.mkdir(destinationDir, { recursive: true });

  return new Promise<ExtractResult>((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(new AppError('ZIP_INVALID', '压缩包无法打开'));
        return;
      }
      let entries = 0;
      let bytes = 0;
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error instanceof AppError ? error : new AppError('ZIP_INVALID', '解压失败'));
      };
      zip.on('error', fail);
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ entries, bytes });
      });
      zip.on('entry', (entry: yauzl.Entry) => {
        entries += 1;
        bytes += entry.uncompressedSize;
        if (entries > maxEntries) return fail(new AppError('ZIP_INVALID', '压缩包条目过多'));
        if (bytes > maxBytes) return fail(new AppError('ZIP_INVALID', '解压后体积超过上限'));
        if (unsafeEntry(entry.fileName)) return fail(new AppError('ZIP_INVALID', '压缩包包含越界路径'));
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (mode === 0o120000) return fail(new AppError('ZIP_INVALID', '压缩包包含符号链接条目'));

        if (entry.fileName.endsWith('/')) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, readStream) => {
          if (streamError || !readStream) return fail(streamError ?? new AppError('ZIP_INVALID', '无法读取条目'));
          const out = path.join(destinationDir, ...entry.fileName.split('/'));
          void fs
            .mkdir(path.dirname(out), { recursive: true })
            .then(() => pipeline(readStream, createWriteStream(out)))
            .then(() => zip.readEntry())
            .catch(fail);
        });
      });
      zip.readEntry();
    });
  });
}
```

`FileService.unzip` 换成：

```ts
  async unzip(root: string, relPath: string, targetDir?: string): Promise<{ entries: number }> {
    const archivePath = await this.sandbox.resolve(root, relPath);
    const archiveStat = await fs.lstat(archivePath);
    if (archiveStat.isSymbolicLink()) throw new AppError('SYMLINK_NOT_ALLOWED', '不允许解压符号链接');
    if (!archiveStat.isFile()) throw new AppError('ZIP_INVALID', '目标不是文件');

    const sourceRel = this.sandbox.normalizeRelative(relPath);
    const destinationRel = targetDir
      ? this.sandbox.normalizeRelative(targetDir)
      : path.posix.dirname(sourceRel) === '.' ? '' : path.posix.dirname(sourceRel);
    const destination = await this.sandbox.resolve(root, destinationRel);
    const result = await extractZipSafe(archivePath, destination, {
      maxEntries: 100_000,
      maxBytes: 10 * 1024 * 1024 * 1024,
    });
    return { entries: result.entries };
  }
```

删除 FileService 里的 `MAX_ZIP_*`、`isUnsafeEntry`、`createWriteStream`/`pipeline`/`yauzl` import（以 lint 结果为准）。

- [ ] **Step 5: 实现备份打包**

`apps/server/src/services/backup-archive.ts`：

```ts
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import type { BackupManifest } from '@mcpanel/shared';
import { DEFAULT_EXCLUDES } from './backup-sources';

export interface ArchiveOptions {
  root: string;
  sources: string[];
  destination: string;
  manifest: BackupManifest;
  onProgress?: (fraction: number) => void;
}

function excluded(rel: string): boolean {
  return rel.split('/').some((segment) => (DEFAULT_EXCLUDES as readonly string[]).includes(segment));
}

async function collectFiles(root: string, rel: string, files: string[]): Promise<void> {
  const absolute = path.join(root, ...rel.split('/'));
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(absolute)) {
      const childRel = `${rel}/${entry}`;
      if (excluded(childRel)) continue;
      await collectFiles(root, childRel, files);
    }
    return;
  }
  if (stat.isFile()) files.push(rel);
}

export async function writeBackupArchive(options: ArchiveOptions): Promise<number> {
  const files: string[] = [];
  for (const source of options.sources) {
    if (excluded(source)) continue;
    await collectFiles(options.root, source, files);
  }

  await fs.mkdir(path.dirname(options.destination), { recursive: true });
  const output = createWriteStream(options.destination);
  const archive = new ZipArchive({ zlib: { level: 6 } });

  const done = new Promise<number>((resolve, reject) => {
    output.on('close', () => resolve(archive.pointer()));
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reject(error);
    });
    archive.on('progress', (data) => {
      const total = data.entries.total || files.length;
      options.onProgress?.(total > 0 ? Math.min(1, data.entries.processed / total) : 0);
    });
  });

  archive.pipe(output);
  archive.append(`${JSON.stringify(options.manifest, null, 2)}\n`, { name: 'manifest.json' });
  for (const rel of files) {
    archive.file(path.join(options.root, ...rel.split('/')), { name: rel });
  }
  await archive.finalize();
  const bytes = await done;
  options.onProgress?.(1);
  return bytes;
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npm test -w @mcpanel/server -- test/unit/zip-extract.test.ts test/unit/backup-archive.test.ts test/integration/files-upload.test.ts`
Expected: 全部 PASS（文件页的解压测试仍应通过）。

- [ ] **Step 7: 提交**

```bash
npm run typecheck && npm test && npm run lint
git add apps/server package.json package-lock.json
git commit -m "feat(server): share safe zip extraction and add backup archiving"
```

---

### Task 4: 严格一致性冻结

**Files:**
- Modify: `apps/server/test/fixtures/fake-rcon.mjs`（支持 save-off/save-all flush/save-on 与日志追加）
- Create: `apps/server/src/services/backup-consistency.ts`
- Test: `apps/server/test/integration/backup-consistency.test.ts`

- [ ] **Step 1: 扩展假 RCON**

`startFakeRcon({ password, port, saveAllDelayMs })` 已有参数；增加 `logFile`：

- 在连接处理器里，命令分支追加：

```js
if (command === 'save-off') return '';
if (command === 'save-on') return '';
if (command === 'save-all flush' || command === 'save-all') {
  setTimeout(() => {
    if (logFile) {
      fs.appendFileSync(logFile, '[Server thread/INFO]: Saved the game\n');
    }
  }, saveAllDelayMs);
  return 'Saved the game';
}
```

顶部 `import fs from 'node:fs';`，函数签名改为 `{ password = 'secret', port = 0, saveAllDelayMs = 0, logFile = null } = {}`。

- [ ] **Step 2: 写失败测试**

`apps/server/test/integration/backup-consistency.test.ts`：

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withFrozenServer } from '../../src/services/backup-consistency';
import { RconService } from '../../src/services/rcon-service';
import { createTestDb, type TestDb } from '../helpers/db';
import { insertInstanceRow } from '../helpers/factory';
import { startFakeRcon } from '../fixtures/fake-rcon.mjs';

let ctx: TestDb | undefined;
let dir: string;
const closers: Array<() => Promise<void>> = [];

async function setup(delayMs = 0, withLog = true) {
  ctx = createTestDb();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-freeze-'));
  const logFile = path.join(dir, 'latest.log');
  if (withLog) await fs.writeFile(logFile, '[Server thread/INFO]: old line\n');
  const password = 'secret';
  const fake = await startFakeRcon({ password, logFile, saveAllDelayMs: delayMs });
  closers.push(fake.close);
  const instance = insertInstanceRow(ctx.db, { name: `freeze-${Date.now()}`, rootPath: dir, rconHost: '127.0.0.1' });
  await fs.writeFile(
    path.join(dir, 'server.properties'),
    `enable-rcon=true\nrcon.port=${fake.port}\nrcon.password=${password}\n`,
  );
  const rcon = new RconService();
  await rcon.test(instance);
  return { instance, rcon, logFile };
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  ctx?.close();
  ctx = undefined;
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe('withFrozenServer', () => {
  it('freezes saves, waits for the flush log line and deletes the log guard afterwards', async () => {
    const { instance, rcon, logFile } = await setup(10);
    const result = await withFrozenServer({ rcon, instance, logFile, waitTimeoutMs: 5_000 }, async () => {
      expect(await fs.readFile(logFile, 'utf8')).toContain('Saved the game');
      return 'packed';
    });
    expect(result).toBe('packed');
  });

  it('aborts when the log never confirms the flush, and still sends save-on', async () => {
    const { instance, rcon, logFile } = await setup(10, false);
    await expect(
      withFrozenServer({ rcon, instance, logFile, waitTimeoutMs: 200 }, async () => 'never'),
    ).rejects.toMatchObject({ code: 'BACKUP_REQUIRES_STOP_OR_RCON' });
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test -w @mcpanel/server -- test/integration/backup-consistency.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现冻结流程**

`apps/server/src/services/backup-consistency.ts`：

```ts
import fs from 'node:fs/promises';
import type { InstanceRow } from '../db/schema';
import { AppError } from '../utils/errors';
import type { RconService } from './rcon-service';

const POLL_INTERVAL_MS = 400;
const SAVED_PATTERN = /Saved the game|Saved the world/i;

export interface FreezeDeps {
  rcon: RconService;
  instance: InstanceRow;
  logFile: string;
  waitTimeoutMs?: number;
}

async function fileSize(file: string): Promise<number | null> {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return null;
  }
}

async function waitForSavedLine(logFile: string, offset: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const size = await fileSize(logFile);
    if (size === null || size <= offset) continue;
    const handle = await fs.open(logFile, 'r');
    try {
      const length = size - offset;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      if (SAVED_PATTERN.test(buffer.toString('utf8'))) return;
    } finally {
      await handle.close();
    }
  }
  throw new AppError('BACKUP_REQUIRES_STOP_OR_RCON', '等待存档写入超时，已中止备份');
}

/**
 * Runs `task` with saving disabled, after a flushed save has been confirmed in the log.
 * `save-on` is always attempted, even when packing throws.
 */
export async function withFrozenServer<T>(deps: FreezeDeps, task: () => Promise<T>): Promise<T> {
  const timeoutMs = deps.waitTimeoutMs ?? 60_000;
  const offset = await fileSize(deps.logFile);
  if (offset === null) {
    throw new AppError('BACKUP_REQUIRES_STOP_OR_RCON', '找不到 logs/latest.log，无法确认存档已写入磁盘');
  }
  await deps.rcon.send(deps.instance, 'save-off');
  try {
    await deps.rcon.send(deps.instance, 'save-all flush');
    await waitForSavedLine(deps.logFile, offset, timeoutMs);
    return await task();
  } finally {
    await deps.rcon.send(deps.instance, 'save-on').catch(() => undefined);
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -w @mcpanel/server -- test/integration/backup-consistency.test.ts`
Expected: 2 个测试 PASS。

- [ ] **Step 6: 提交**

```bash
npm run typecheck && npm test && npm run lint
git add apps/server/src apps/server/test
git commit -m "feat(server): freeze servers consistently around backups"
```

---

### Task 5: BackupService（创建、保留、列表、删除、启动恢复）

**Files:**
- Create: `apps/server/src/services/task-tracker.ts`
- Create: `apps/server/src/services/backup-service.ts`
- Test: `apps/server/test/integration/backup-service.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupService } from '../../src/services/backup-service';
import { TaskTracker } from '../../src/services/task-tracker';
import { AuditService } from '../../src/services/audit-service';
import { silentLogger } from '../../src/logger';
import { insertInstanceRow } from '../helpers/factory';
import { createTestDb, type TestDb } from '../helpers/db';

let ctx: TestDb | undefined;
const dirs: string[] = [];

async function setup(overrides: { backupKeep?: number } = {}) {
  ctx = createTestDb();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-backup-'));
  dirs.push(dir);
  const root = path.join(dir, 'server');
  await fs.mkdir(path.join(root, 'world', 'region'), { recursive: true });
  await fs.writeFile(path.join(root, 'world', 'level.dat'), 'level-data');
  await fs.writeFile(path.join(root, 'world', 'region', 'r.0.0.mca'), 'region');
  await fs.writeFile(path.join(root, 'server.properties'), 'motd=hi\n');
  const instance = insertInstanceRow(ctx.db, { rootPath: root, backupKeep: overrides.backupKeep ?? 10 });
  const service = new BackupService({
    db: ctx.db,
    dataDir: dir,
    instances: { list: () => [instance], get: () => instance } as never,
    supervisor: { getStatus: () => ({ instanceId: instance.id, state: 'stopped', pid: null, startedAt: null, exitCode: null, error: null }) } as never,
    rcon: { statusFor: async () => 'disabled', send: async () => '' } as never,
    tasks: new TaskTracker(),
    logger: silentLogger(),
    audit: new AuditService(ctx.db),
  });
  return { service, instance, dir, root };
}

afterEach(async () => {
  ctx?.close();
  ctx = undefined;
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('BackupService', () => {
  it('creates a cold backup with a manifest and marks it ready', async () => {
    const { service, instance, dir } = await setup();
    const { backupId, done } = service.startCreate(instance, 'manual');
    await done;
    const backups = service.list(instance.id);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({ id: backupId, status: 'ready', kind: 'manual' });
    const file = path.join(dir, 'backups', instance.id, backups[0]!.filename);
    expect((await fs.stat(file)).size).toBe(backups[0]!.sizeBytes);
    expect(service.manifest(instance.id, backupId)).toMatchObject({ schemaVersion: 1, instanceId: instance.id });
  });

  it('keeps the newest pre_restore backup even when over the limit', async () => {
    const { service, instance } = await setup({ backupKeep: 1 });
    const first = service.startCreate(instance, 'pre_restore');
    await first.done;
    const second = service.startCreate(instance, 'manual');
    await second.done;
    const third = service.startCreate(instance, 'manual');
    await third.done;
    const backups = service.list(instance.id);
    expect(backups.some((backup) => backup.kind === 'pre_restore')).toBe(true);
    expect(backups.length).toBeGreaterThanOrEqual(2);
  });

  it('marks interrupted records on boot and deletes stale part files', async () => {
    const { service, instance, dir } = await setup();
    ctx!.sqlite
      .prepare(`INSERT INTO backups (id, instance_id, filename, kind, status, includes_mods, created_at) VALUES (?, ?, ?, 'manual', 'creating', 0, ?)`)
      .run('b1', instance.id, 'x.zip', Date.now());
    await fs.mkdir(path.join(dir, 'tmp'), { recursive: true });
    const stale = path.join(dir, 'tmp', 'backup-old.zip.part');
    await fs.writeFile(stale, 'partial');
    const old = Date.now() / 1000 - 25 * 3600;
    await fs.utimes(stale, old, old);
    await service.recoverOnBoot();
    expect(service.list(instance.id)[0]).toMatchObject({ status: 'failed' });
    await expect(fs.stat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/server -- test/integration/backup-service.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 TaskTracker**

`apps/server/src/services/task-tracker.ts`：

```ts
import { randomUUID } from 'node:crypto';
import type { TaskInfo } from '@mcpanel/shared';

const MAX_AGE_MS = 60 * 60 * 1000;

export class TaskTracker {
  private readonly tasks = new Map<string, TaskInfo>();
  private sink: ((task: TaskInfo) => void) | null = null;

  setSink(sink: (task: TaskInfo) => void): void {
    this.sink = sink;
  }

  start(kind: TaskInfo['kind'], instanceId: string): TaskInfo {
    const task: TaskInfo = {
      id: randomUUID(),
      kind,
      instanceId,
      status: 'running',
      progress: 0,
      message: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.tasks.set(task.id, task);
    this.publish(task);
    return task;
  }

  update(id: string, patch: Partial<Pick<TaskInfo, 'progress' | 'message'>>): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'running') return;
    Object.assign(task, patch);
    this.publish(task);
  }

  finish(id: string, status: 'success' | 'failed', message: string | null = null): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.status = status;
    task.message = message;
    task.progress = status === 'success' ? 1 : task.progress;
    task.finishedAt = new Date().toISOString();
    this.publish(task);
  }

  get(id: string): TaskInfo | null {
    return this.tasks.get(id) ?? null;
  }

  cleanup(now = Date.now()): void {
    for (const [id, task] of this.tasks) {
      const reference = task.finishedAt ?? task.startedAt;
      if (now - new Date(reference).getTime() > MAX_AGE_MS) this.tasks.delete(id);
    }
  }

  private publish(task: TaskInfo): void {
    this.sink?.({ ...task });
  }
}
```

- [ ] **Step 4: 实现 BackupService**

`apps/server/src/services/backup-service.ts`：

```ts
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BackupInfo, BackupKind, BackupManifest, TaskInfo } from '@mcpanel/shared';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { PANEL_VERSION } from '@mcpanel/shared';
import type { DB } from '../db/client';
import { backups, type InstanceRow } from '../db/schema';
import type { InstanceService } from './instance-service';
import type { InstanceSupervisor } from './instance-supervisor';
import type { RconService } from './rcon-service';
import type { AuditService } from './audit-service';
import type { TaskTracker } from './task-tracker';
import { planBackupSources } from './backup-sources';
import { writeBackupArchive } from './backup-archive';
import { withFrozenServer } from './backup-consistency';
import { diskUsage } from '../utils/disk';
import { AppError } from '../utils/errors';

export interface BackupServiceDeps {
  db: DB;
  dataDir: string;
  instances: InstanceService;
  supervisor: InstanceSupervisor;
  rcon: RconService;
  tasks: TaskTracker;
  logger: Logger;
  audit: AuditService;
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/^(\d{8})(\d{6})$/, '$1-$2');
}

function toInfo(row: typeof backups.$inferSelect): BackupInfo {
  return {
    id: row.id,
    instanceId: row.instanceId,
    filename: row.filename,
    kind: row.kind,
    status: row.status,
    sizeBytes: row.sizeBytes,
    includesMods: row.includesMods,
    error: row.error,
    createdAt: new Date(row.createdAt).toISOString(),
    completedAt: row.completedAt === null ? null : new Date(row.completedAt).toISOString(),
  };
}

export class BackupService {
  private readonly locks = new Set<string>();
  private readonly manifests = new Map<string, BackupManifest & { instanceId: string }>();

  constructor(private readonly deps: BackupServiceDeps) {}

  list(instanceId: string): BackupInfo[] {
    return this.deps.db
      .select()
      .from(backups)
      .where(eq(backups.instanceId, instanceId))
      .orderBy(desc(backups.createdAt))
      .all()
      .map(toInfo);
  }

  manifest(instanceId: string, backupId: string): (BackupManifest & { instanceId: string }) | null {
    const cached = this.manifests.get(backupId);
    if (cached) return cached;
    const row = this.deps.db
      .select()
      .from(backups)
      .where(and(eq(backups.id, backupId), eq(backups.instanceId, instanceId)))
      .get();
    if (!row?.manifestJson) return null;
    try {
      const parsed = JSON.parse(row.manifestJson) as BackupManifest;
      const value = { ...parsed, instanceId };
      this.manifests.set(backupId, value);
      return value;
    } catch {
      return null;
    }
  }

  filePath(instanceId: string, backupId: string): string {
    const row = this.deps.db
      .select()
      .from(backups)
      .where(and(eq(backups.id, backupId), eq(backups.instanceId, instanceId)))
      .get();
    if (!row) throw new AppError('NOT_FOUND', '备份不存在');
    return path.join(this.deps.dataDir, 'backups', instanceId, row.filename);
  }

  startCreate(row: InstanceRow, kind: BackupKind): { task: TaskInfo; backupId: string; done: Promise<void> } {
    const task = this.deps.tasks.start('backup', row.id);
    const backupId = randomUUID();
    const done = this.withInstanceLock(row.id, () => this.createInternal(row, kind, backupId, task));
    return { task, backupId, done };
  }

  async remove(row: InstanceRow, backupId: string): Promise<void> {
    const backup = this.deps.db
      .select()
      .from(backups)
      .where(and(eq(backups.id, backupId), eq(backups.instanceId, row.id)))
      .get();
    if (!backup) throw new AppError('NOT_FOUND', '备份不存在');
    if (backup.status !== 'ready') throw new AppError('BACKUP_BUSY', '备份正在使用中');
    await fs.rm(path.join(this.deps.dataDir, 'backups', row.id, backup.filename), { force: true });
    this.deps.db.delete(backups).where(eq(backups.id, backupId)).run();
    this.manifests.delete(backupId);
  }

  async recoverOnBoot(): Promise<void> {
    const creating = this.deps.db.select().from(backups).where(eq(backups.status, 'creating')).all();
    for (const row of creating) {
      this.deps.db
        .update(backups)
        .set({ status: 'failed', error: '面板重启导致备份中断', completedAt: Date.now() })
        .where(eq(backups.id, row.id))
        .run();
    }
    const restoring = this.deps.db.select().from(backups).where(eq(backups.status, 'restoring')).all();
    for (const row of restoring) {
      this.deps.db.update(backups).set({ status: 'ready' }).where(eq(backups.id, row.id)).run();
    }
    const tmpDir = path.join(this.deps.dataDir, 'tmp');
    const entries = await fs.readdir(tmpDir).catch(() => [] as string[]);
    for (const entry of entries) {
      if (!entry.endsWith('.part')) continue;
      const file = path.join(tmpDir, entry);
      const stat = await fs.stat(file).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 24 * 3600 * 1000) await fs.rm(file, { force: true });
    }
    for (const instance of this.deps.instances.list()) {
      const status = this.deps.supervisor.getStatus(instance.id);
      if (status.state !== 'running' && status.state !== 'orphaned') continue;
      const rconStatus = await this.deps.rcon.statusFor(instance);
      if (rconStatus === 'connected') await this.deps.rcon.send(instance, 'save-on').catch(() => undefined);
    }
  }

  async withInstanceLock<T>(instanceId: string, task: () => Promise<T>): Promise<T> {
    if (this.locks.has(instanceId)) throw new AppError('BACKUP_BUSY', '已有备份或恢复任务在进行');
    this.locks.add(instanceId);
    try {
      return await task();
    } finally {
      this.locks.delete(instanceId);
    }
  }

  private async createInternal(row: InstanceRow, kind: BackupKind, backupId: string, task: TaskInfo): Promise<void> {
    const tasks = this.deps.tasks;
    const instanceDir = path.join(this.deps.dataDir, 'backups', row.id);
    const tmpFile = path.join(this.deps.dataDir, 'tmp', `backup-${backupId}.zip.part`);
    const createdAt = Date.now();
    try {
      const state = this.deps.supervisor.getStatus(row.id).state;
      if (state === 'starting' || state === 'stopping' || state === 'unknown') {
        throw new AppError('INVALID_STATE', `当前状态 ${state} 不能备份`);
      }
      const running = state === 'running' || state === 'orphaned';
      if (running) {
        const rconStatus = await this.deps.rcon.statusFor(row);
        if (rconStatus !== 'connected') {
          throw new AppError('BACKUP_REQUIRES_STOP_OR_RCON', '服务器运行中且 RCON 不可用，请先停服再备份');
        }
      }
      const plan = await planBackupSources(row.rootPath, {
        levelName: await this.levelName(row),
        includeMods: row.backupIncludeMods,
        includeConfig: row.backupIncludeConfig,
        extraPaths: JSON.parse(row.backupExtraPaths) as string[],
      });
      const disk = await diskUsage(this.deps.dataDir);
      if (disk.free < plan.totalBytes * 1.5) {
        throw new AppError('INSUFFICIENT_DISK', '磁盘剩余空间不足（需要源大小的 1.5 倍）');
      }

      const manifest: BackupManifest = {
        schemaVersion: 1,
        panelVersion: PANEL_VERSION,
        instanceName: row.name,
        createdAt: new Date(createdAt).toISOString(),
        sources: plan.sources,
        fileCount: plan.fileCount,
        totalBytes: plan.totalBytes,
      };
      const filename = `${stamp(new Date(createdAt))}-${kind}-${backupId.slice(0, 6)}.zip`;
      this.deps.db
        .insert(backups)
        .values({
          id: backupId,
          instanceId: row.id,
          filename,
          kind,
          status: 'creating',
          includesMods: row.backupIncludeMods,
          createdAt,
        })
        .run();

      const pack = async () => {
        const bytes = await writeBackupArchive({
          root: row.rootPath,
          sources: plan.sources,
          destination: tmpFile,
          manifest,
          onProgress: (fraction) => tasks.update(task.id, { progress: Math.round(fraction * 100) / 100 }),
        });
        await fs.mkdir(instanceDir, { recursive: true });
        await fs.rename(tmpFile, path.join(instanceDir, filename));
        return bytes;
      };
      const bytes = running
        ? await withFrozenServer(
            { rcon: this.deps.rcon, instance: row, logFile: path.join(row.rootPath, 'logs', 'latest.log') },
            pack,
          )
        : await pack();

      this.deps.db
        .update(backups)
        .set({
          status: 'ready',
          sizeBytes: bytes,
          manifestJson: JSON.stringify(manifest),
          completedAt: Date.now(),
        })
        .where(eq(backups.id, backupId))
        .run();
      this.manifests.set(backupId, { ...manifest, instanceId: row.id });
      await this.enforceRetention(row);
      tasks.finish(task.id, 'success', '备份完成');
    } catch (error) {
      const message = error instanceof AppError ? error.message : '备份失败';
      this.deps.db
        .update(backups)
        .set({ status: 'failed', error: message, completedAt: Date.now() })
        .where(eq(backups.id, backupId))
        .run();
      await fs.rm(tmpFile, { force: true });
      tasks.finish(task.id, 'failed', message);
      this.deps.logger.error({ err: error, instanceId: row.id }, 'backup failed');
      throw error;
    }
  }

  private async levelName(row: InstanceRow): Promise<string> {
    const { loadServerProperties, propertyValue } = await import('./properties-service');
    const loaded = await loadServerProperties(row.rootPath).catch(() => null);
    return propertyValue(loaded?.parsed ?? null, 'level-name', 'world') || 'world';
  }

  private async enforceRetention(row: InstanceRow): Promise<void> {
    const ready = this.deps.db
      .select()
      .from(backups)
      .where(and(eq(backups.instanceId, row.id), eq(backups.status, 'ready')))
      .orderBy(desc(backups.createdAt))
      .all();
    const keep = new Set(ready.slice(0, row.backupKeep).map((backup) => backup.id));
    const newestPreRestore = ready.find((backup) => backup.kind === 'pre_restore');
    if (newestPreRestore) keep.add(newestPreRestore.id);
    for (const backup of ready) {
      if (keep.has(backup.id)) continue;
      try {
        await fs.rm(path.join(this.deps.dataDir, 'backups', row.id, backup.filename), { force: true });
        this.deps.db.delete(backups).where(eq(backups.id, backup.id)).run();
        this.manifests.delete(backup.id);
      } catch (error) {
        this.deps.logger.warn({ err: error, backupId: backup.id }, 'retention failed for one backup');
      }
    }
  }
}
```

> 实现时把 `levelName` 里的动态 import 换成文件顶部静态 import（`loadServerProperties`、`propertyValue`），并删除未使用的 `asc`。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -w @mcpanel/server -- test/integration/backup-service.test.ts`
Expected: 3 个测试 PASS。

- [ ] **Step 6: 提交**

```bash
npm run typecheck && npm test && npm run lint
git add apps/server/src apps/server/test
git commit -m "feat(server): create cold backups with retention and boot recovery"
```

---

### Task 6: RestoreService（pre_restore、安全替换、回滚）

**Files:**
- Modify: `apps/server/src/services/backup-service.ts`（`createInternal` 接受进度区间；新增 `createPreRestore`）
- Create: `apps/server/src/services/restore-service.ts`
- Test: `apps/server/test/integration/restore-service.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/services/audit-service';
import { BackupService } from '../../src/services/backup-service';
import { RestoreService } from '../../src/services/restore-service';
import { TaskTracker } from '../../src/services/task-tracker';
import { silentLogger } from '../../src/logger';
import { insertInstanceRow } from '../helpers/factory';
import { createTestDb, type TestDb } from '../helpers/db';

let ctx: TestDb | undefined;
const dirs: string[] = [];

async function setup() {
  ctx = createTestDb();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-restore-'));
  dirs.push(dir);
  const root = path.join(dir, 'server');
  await fs.mkdir(path.join(root, 'world'), { recursive: true });
  await fs.writeFile(path.join(root, 'world', 'level.dat'), 'v1');
  await fs.writeFile(path.join(root, 'server.properties'), 'motd=v1\n');
  const instance = insertInstanceRow(ctx.db, { rootPath: root });
  const audit = new AuditService(ctx.db);
  const tasks = new TaskTracker();
  const backups = new BackupService({
    db: ctx.db,
    dataDir: dir,
    instances: { list: () => [instance], get: () => instance } as never,
    supervisor: { getStatus: () => ({ instanceId: instance.id, state: 'stopped', pid: null, startedAt: null, exitCode: null, error: null }) } as never,
    rcon: { statusFor: async () => 'disabled', send: async () => '' } as never,
    tasks,
    logger: silentLogger(),
    audit,
  });
  const restore = new RestoreService({ db: ctx.db, dataDir: dir, backups, tasks, audit, logger: silentLogger() });
  return { dir, root, instance, backups, restore };
}

afterEach(async () => {
  ctx?.close();
  ctx = undefined;
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('RestoreService', () => {
  it('restores a backup, keeps a pre_restore copy and reports success', async () => {
    const { root, instance, backups, restore } = await setup();
    const created = backups.startCreate(instance, 'manual');
    await created.done;

    await fs.writeFile(path.join(root, 'world', 'level.dat'), 'v2');
    await fs.writeFile(path.join(root, 'server.properties'), 'motd=v2\n');

    const task = restore.start(instance, created.backupId, 'user-1');
    await task.done;

    expect(await fs.readFile(path.join(root, 'world', 'level.dat'), 'utf8')).toBe('v1');
    expect(await fs.readFile(path.join(root, 'server.properties'), 'utf8')).toBe('motd=v1\n');
    expect(backups.list(instance.id).some((backup) => backup.kind === 'pre_restore' && backup.status === 'ready')).toBe(true);
    await expect(fs.stat(path.join(root, '.mcpanel-tmp', `restore-${created.backupId}`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires the instance to be stopped', async () => {
    const { instance, backups, restore } = await setup();
    const created = backups.startCreate(instance, 'manual');
    await created.done;
    const running = new RestoreService({
      db: ctx!.db,
      dataDir: path.dirname(path.dirname(instance.rootPath)),
      backups,
      tasks: new TaskTracker(),
      audit: new AuditService(ctx!.db),
      logger: silentLogger(),
      stateOf: () => 'running',
    });
    await expect(running.start(instance, created.backupId, null)).rejects.toMatchObject({
      code: 'RESTORE_REQUIRES_STOP',
    });
  });

  it('refuses unknown backups', async () => {
    const { instance, restore } = await setup();
    await expect(restore.start(instance, 'missing', null)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/server -- test/integration/restore-service.test.ts`
Expected: FAIL，`restore-service` 不存在。

- [ ] **Step 3: 让 BackupService 支持受控进度与 pre_restore**

`createInternal` 增加参数 `progressSpan: [number, number] = [0, 1]`，`onProgress` 改为：

```ts
onProgress: (fraction) =>
  tasks.update(task.id, { progress: progressSpan[0] + fraction * (progressSpan[1] - progressSpan[0]) }),
```

新增公开方法（调用方必须已持有实例锁）：

```ts
  async createPreRestore(row: InstanceRow, task: TaskInfo, progressSpan: [number, number]): Promise<string> {
    const backupId = randomUUID();
    await this.createInternal(row, 'pre_restore', backupId, task, progressSpan);
    return backupId;
  }
```

- [ ] **Step 4: 实现 RestoreService**

`apps/server/src/services/restore-service.ts`：

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BackupManifest, InstanceState, TaskInfo } from '@mcpanel/shared';
import yauzl from 'yauzl';
import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { DB } from '../db/client';
import { backups, type InstanceRow } from '../db/schema';
import type { AuditService } from './audit-service';
import type { BackupService } from './backup-service';
import type { TaskTracker } from './task-tracker';
import { extractZipSafe } from '../utils/zip-extract';
import { diskUsage } from '../utils/disk';
import { AppError } from '../utils/errors';

export interface RestoreServiceDeps {
  db: DB;
  dataDir: string;
  backups: BackupService;
  tasks: TaskTracker;
  audit: AuditService;
  logger: Logger;
  stateOf?: (instanceId: string) => InstanceState;
}

function readManifest(file: string): Promise<BackupManifest> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(new AppError('ZIP_INVALID', '备份文件无法打开'));
        return;
      }
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error instanceof AppError ? error : new AppError('ZIP_INVALID', '备份 manifest 读取失败'));
      };
      zip.on('error', fail);
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName !== 'manifest.json') return fail(new AppError('ZIP_INVALID', '备份缺少 manifest.json'));
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail(streamError ?? new Error('无法读取 manifest'));
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', fail);
          stream.on('end', () => {
            if (settled) return;
            settled = true;
            zip.close();
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as BackupManifest;
              if (parsed.schemaVersion !== 1) throw new AppError('ZIP_INVALID', '不支持的备份格式版本');
              resolve(parsed);
            } catch (error) {
              reject(error instanceof AppError ? error : new AppError('ZIP_INVALID', '备份 manifest 格式错误'));
            }
          });
        });
      });
      zip.readEntry();
    });
  });
}

export class RestoreService {
  constructor(private readonly deps: RestoreServiceDeps) {}

  start(row: InstanceRow, backupId: string, userId: string | null): { task: TaskInfo; done: Promise<void> } {
    const task = this.deps.tasks.start('restore', row.id);
    const done = this.deps.backups.withInstanceLock(row.id, () => this.restoreInternal(row, backupId, userId, task));
    return { task, done };
  }

  private async restoreInternal(
    row: InstanceRow,
    backupId: string,
    userId: string | null,
    task: TaskInfo,
  ): Promise<void> {
    const db = this.deps.db;
    const source = db
      .select()
      .from(backups)
      .where(and(eq(backups.id, backupId), eq(backups.instanceId, row.id)))
      .get();
    if (!source) throw new AppError('NOT_FOUND', '备份不存在');
    if (source.status !== 'ready') throw new AppError('BACKUP_BUSY', '备份正在使用中');
    const state = this.deps.stateOf?.(row.id) ?? 'stopped';
    if (state !== 'stopped') throw new AppError('RESTORE_REQUIRES_STOP', '恢复前必须停止服务器');

    const file = path.join(this.deps.dataDir, 'backups', row.id, source.filename);
    const manifest = await readManifest(file);
    const disk = await diskUsage(row.rootPath);
    if (disk.free < manifest.totalBytes * 1.2) {
      throw new AppError('INSUFFICIENT_DISK', '磁盘剩余空间不足（需要备份大小的 1.2 倍）');
    }

    db.update(backups).set({ status: 'restoring' }).where(eq(backups.id, backupId)).run();
    const restoreDir = path.join(row.rootPath, '.mcpanel-tmp', `restore-${backupId}`);
    const rollbackDir = path.join(row.rootPath, '.mcpanel-tmp', `rollback-${backupId}`);

    try {
      await this.deps.backups.createPreRestore(row, task, [0, 0.2]);
      await fs.rm(restoreDir, { recursive: true, force: true });
      await fs.rm(rollbackDir, { recursive: true, force: true });
      await extractZipSafe(file, restoreDir, {
        maxEntries: 1_000_000,
        maxBytes: Math.max(manifest.totalBytes * 1.1, 2 * 1024 * 1024 * 1024),
      });
      for (const sourceRel of manifest.sources) {
        const stat = await fs.lstat(path.join(restoreDir, ...sourceRel.split('/'))).catch(() => null);
        if (!stat) throw new AppError('ZIP_INVALID', `备份缺少内容：${sourceRel}`);
      }
      this.deps.tasks.update(task.id, { progress: 0.7 });

      await fs.mkdir(rollbackDir, { recursive: true });
      const moved: string[] = [];
      for (const sourceRel of manifest.sources) {
        const current = path.join(row.rootPath, ...sourceRel.split('/'));
        const exists = await fs.lstat(current).then(
          () => true,
          () => false,
        );
        if (!exists) continue;
        const backupTarget = path.join(rollbackDir, ...sourceRel.split('/'));
        await fs.mkdir(path.dirname(backupTarget), { recursive: true });
        await fs.rename(current, backupTarget);
        moved.push(sourceRel);
      }

      try {
        for (const sourceRel of manifest.sources) {
          const target = path.join(row.rootPath, ...sourceRel.split('/'));
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.rename(path.join(restoreDir, ...sourceRel.split('/')), target);
        }
      } catch (error) {
        for (const sourceRel of moved) {
          const target = path.join(row.rootPath, ...sourceRel.split('/'));
          await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
          await fs.rename(path.join(rollbackDir, ...sourceRel.split('/')), target).catch(() => undefined);
        }
        throw error;
      }

      await fs.rm(restoreDir, { recursive: true, force: true });
      await fs.rm(rollbackDir, { recursive: true, force: true });
      db.update(backups).set({ status: 'ready' }).where(eq(backups.id, backupId)).run();
      this.deps.tasks.update(task.id, { progress: 1 });
      this.deps.audit.record({
        userId,
        action: 'backup.restore',
        targetType: 'instance',
        targetId: row.id,
        detail: { backupId, sources: manifest.sources },
      });
      this.deps.tasks.finish(task.id, 'success', '恢复完成');
    } catch (error) {
      db.update(backups).set({ status: 'ready' }).where(eq(backups.id, backupId)).run();
      const message = error instanceof AppError ? error.message : '恢复失败';
      this.deps.audit.record({
        userId,
        action: 'backup.restore_failed',
        targetType: 'instance',
        targetId: row.id,
        detail: { backupId, error: message },
      });
      this.deps.tasks.finish(task.id, 'failed', message);
      this.deps.logger.error({ err: error, instanceId: row.id, backupId }, 'restore failed');
      throw error;
    }
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -w @mcpanel/server -- test/integration/restore-service.test.ts`
Expected: 3 个测试 PASS。

- [ ] **Step 6: 提交**

```bash
npm run typecheck && npm test && npm run lint
git add apps/server/src apps/server/test
git commit -m "feat(server): restore backups with pre-restore copy and rollback"
```

---

### Task 7: 备份路由、任务频道与恢复残留清理

**Files:**
- Create: `apps/server/src/routes/backups.ts`
- Modify: `apps/server/src/services/restore-service.ts`（导出 `rollbackLeftovers`）
- Modify: `apps/server/src/routes/instances.ts`（`cleanup-restore`、`restore-leftovers`）
- Modify: `apps/server/src/ws/hub.ts`（task 频道）
- Modify: `apps/server/src/app.ts`、`apps/server/src/index.ts`
- Test: `apps/server/test/integration/backups-api.test.ts`
- Test: `apps/server/test/integration/ws.test.ts`（追加任务频道用例）

- [ ] **Step 1: 写失败测试**

`apps/server/test/integration/backups-api.test.ts`：

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
import { LocalNodeDriver } from '../../src/nodes/local-driver';
import { PathSandbox } from '../../src/nodes/path-sandbox';
import { AuditService } from '../../src/services/audit-service';
import { BackupService } from '../../src/services/backup-service';
import { FileService } from '../../src/services/file-service';
import { InstanceService } from '../../src/services/instance-service';
import { ProbeService } from '../../src/services/probe-service';
import { RestoreService } from '../../src/services/restore-service';
import { RconService } from '../../src/services/rcon-service';
import { TaskTracker } from '../../src/services/task-tracker';
import type { InstanceSupervisor } from '../../src/services/instance-supervisor';
import { insertInstance, insertUser } from '../helpers/factory';
import { createTestDb, type TestDb } from '../helpers/db';
import { CookieJar, TEST_ORIGIN, json } from '../helpers/http';

let ctx: TestDb | undefined;
const dirs: string[] = [];

async function makeApp() {
  ctx = createTestDb();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-backups-api-'));
  dirs.push(dataDir);
  const root = path.join(dataDir, 'server');
  await fs.mkdir(path.join(root, 'world'), { recursive: true });
  await fs.writeFile(path.join(root, 'world', 'level.dat'), 'v1');
  await fs.writeFile(path.join(root, 'server.properties'), 'motd=v1\n');

  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: dataDir });
  const sessions = new SessionService(ctx.db);
  const { token } = sessions.create(insertUser(ctx.db), null, null);
  const instanceId = insertInstance(ctx.db, { rootPath: root });
  const sandbox = new PathSandbox(dataDir);
  const supervisor = {
    getStatus: () => ({ instanceId, state: 'stopped', pid: null, startedAt: null, exitCode: null, error: null }),
  } as unknown as InstanceSupervisor;
  const instances = new InstanceService(ctx.db, dataDir);
  const tasks = new TaskTracker();
  const audit = new AuditService(ctx.db);
  const backups = new BackupService({
    db: ctx.db,
    dataDir,
    instances,
    supervisor,
    rcon: new RconService(),
    tasks,
    logger: silentLogger(),
    audit,
  });
  const restore = new RestoreService({ db: ctx.db, dataDir, backups, tasks, audit, logger: silentLogger() });
  const app = await buildApp(
    config,
    ctx.db,
    {
      sessions,
      audit,
      loginThrottle: new LoginThrottle(),
      instances,
      supervisor,
      rcon: new RconService(),
      driver: new LocalNodeDriver(sandbox),
      probe: new ProbeService(sandbox, async () => null),
      files: new FileService(sandbox),
      sandbox,
      backups,
      restore,
    },
    { logger: silentLogger() },
  );

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

async function waitReady(app: Awaited<ReturnType<typeof makeApp>>['app'], instanceId: string, headers: Record<string, string>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const list = await app.inject({ method: 'GET', url: `/api/instances/${instanceId}/backups`, headers });
    const items = json<{ items: Array<{ id: string; status: string; error: string | null }> }>(list).items;
    const ready = items.find((item) => item.status === 'ready');
    if (ready) return ready;
    const failed = items.find((item) => item.status === 'failed');
    if (failed) throw new Error(`backup failed: ${failed.error}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('backup timed out');
}

afterEach(async () => {
  ctx?.close();
  ctx = undefined;
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('backups API', () => {
  it('creates, lists, downloads and deletes a backup', async () => {
    const { app, instanceId, headers, readHeaders } = await makeApp();
    const created = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/backups`,
      headers,
      payload: {},
    });
    expect(created.statusCode).toBe(202);
    const { taskId } = json<{ taskId: string }>(created);
    expect(taskId).toBeTruthy();

    const ready = await waitReady(app, instanceId, readHeaders);
    const manifest = await app.inject({
      method: 'GET',
      url: `/api/instances/${instanceId}/backups/${ready.id}/manifest`,
      headers: readHeaders,
    });
    expect(json(manifest)).toMatchObject({ schemaVersion: 1 });

    const download = await app.inject({
      method: 'GET',
      url: `/api/instances/${instanceId}/backups/${ready.id}/download`,
      headers: readHeaders,
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toContain('application/zip');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/instances/${instanceId}/backups/${ready.id}`,
      headers,
    });
    expect(deleted.statusCode).toBe(204);
    const list = await app.inject({ method: 'GET', url: `/api/instances/${instanceId}/backups`, headers: readHeaders });
    expect(json<{ items: unknown[] }>(list).items).toHaveLength(0);
  });

  it('restores a backup over modified files', async () => {
    const { app, root, instanceId, headers, readHeaders } = await makeApp();
    await app.inject({ method: 'POST', url: `/api/instances/${instanceId}/backups`, headers, payload: {} });
    const ready = await waitReady(app, instanceId, readHeaders);

    await fs.writeFile(path.join(root, 'world', 'level.dat'), 'v2');
    const restored = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/backups/${ready.id}/restore`,
      headers,
      payload: { confirm: true },
    });
    expect(restored.statusCode).toBe(202);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fs.readFile(path.join(root, 'world', 'level.dat'), 'utf8')) === 'v1') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await fs.readFile(path.join(root, 'world', 'level.dat'), 'utf8')).toBe('v1');
  });
});
```

`apps/server/test/integration/ws.test.ts` 追加（沿用该文件的 makeApp 结构）：订阅一个不存在的任务 → 收到 NOT_FOUND；直接订阅 `task:<uuid>` 合法（不再返回 FORBIDDEN）。

```ts
  it('rejects subscriptions to unknown tasks', async () => {
    const { subscriber } = await connect(); // 复用文件中现有的连接辅助
    subscriber.send(JSON.stringify({ type: 'subscribe', channel: `task:${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}` }));
    const message = await subscriber.nextOfType('error');
    expect(message).toMatchObject({ code: 'NOT_FOUND' });
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/server -- test/integration/backups-api.test.ts`
Expected: FAIL，`backups` 不在 `AppServices`，路由 404。

- [ ] **Step 3: 实现备份路由**

`apps/server/src/routes/backups.ts`：

```ts
import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { restoreBackupSchema } from '@mcpanel/shared';
import { createGuards } from '../auth/guard';
import type { SessionService } from '../auth/session';
import type { AuditService } from '../services/audit-service';
import type { BackupService } from '../services/backup-service';
import type { InstanceService } from '../services/instance-service';
import type { RestoreService } from '../services/restore-service';
import { AppError } from '../utils/errors';

export interface BackupRouteDeps {
  sessions: SessionService;
  audit: AuditService;
  instances: InstanceService;
  backups: BackupService;
  restore: RestoreService;
}

export function registerBackupRoutes(app: FastifyInstance, deps: BackupRouteDeps): void {
  const { sessions, audit, instances, backups, restore } = deps;
  const { requireAuth, requireOrigin } = createGuards(sessions);
  const read = { preHandler: [requireAuth] };
  const write = { preHandler: [requireOrigin, requireAuth, app.csrfProtection] };

  app.get<{ Params: { id: string } }>('/api/instances/:id/backups', read, async (request) => ({
    items: backups.list(request.params.id),
  }));

  app.post<{ Params: { id: string } }>('/api/instances/:id/backups', write, async (request, reply) => {
    const row = instances.get(request.params.id);
    const { task, backupId, done } = backups.startCreate(row, 'manual');
    void done.catch(() => undefined);
    audit.record({
      userId: request.user?.id,
      action: 'backup.create',
      targetType: 'instance',
      targetId: row.id,
      detail: { backupId },
      ip: request.ip,
    });
    return reply.status(202).send({ taskId: task.id, backupId });
  });

  app.get<{ Params: { id: string; backupId: string } }>(
    '/api/instances/:id/backups/:backupId/manifest',
    read,
    async (request) => {
      const manifest = backups.manifest(request.params.id, request.params.backupId);
      if (!manifest) throw new AppError('NOT_FOUND', '备份清单不存在');
      return manifest;
    },
  );

  app.get<{ Params: { id: string; backupId: string } }>(
    '/api/instances/:id/backups/:backupId/download',
    read,
    async (request, reply) => {
      const file = backups.filePath(request.params.id, request.params.backupId);
      reply.type('application/zip');
      reply.header('Content-Disposition', `attachment; filename="backup.zip"`);
      return reply.send(createReadStream(file));
    },
  );

  app.delete<{ Params: { id: string; backupId: string } }>(
    '/api/instances/:id/backups/:backupId',
    write,
    async (request, reply) => {
      const row = instances.get(request.params.id);
      await backups.remove(row, request.params.backupId);
      audit.record({
        userId: request.user?.id,
        action: 'backup.delete',
        targetType: 'instance',
        targetId: row.id,
        detail: { backupId: request.params.backupId },
        ip: request.ip,
      });
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string; backupId: string } }>(
    '/api/instances/:id/backups/:backupId/restore',
    write,
    async (request, reply) => {
      restoreBackupSchema.parse(request.body);
      const row = instances.get(request.params.id);
      const { task, done } = restore.start(row, request.params.backupId, request.user?.id ?? null);
      void done.catch(() => undefined);
      return reply.status(202).send({ taskId: task.id });
    },
  );
}
```

- [ ] **Step 4: 任务频道与恢复残留**

`restore-service.ts` 追加导出：

```ts
export async function rollbackLeftovers(root: string): Promise<string[]> {
  const base = path.join(root, '.mcpanel-tmp');
  const entries = await fs.readdir(base).catch(() => [] as string[]);
  const leftovers: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('rollback-')) continue;
    const dir = path.join(base, entry);
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    if (files.length > 0) leftovers.push(dir);
  }
  return leftovers;
}
```

`routes/instances.ts` 追加：

```ts
  app.get<{ Params: { id: string } }>('/api/instances/:id/restore-leftovers', read, async (request) => ({
    paths: await rollbackLeftovers(instances.get(request.params.id).rootPath),
  }));

  app.post<{ Params: { id: string } }>('/api/instances/:id/actions/cleanup-restore', write, async (request, reply) => {
    const row = instances.get(request.params.id);
    const state = supervisor.getStatus(row.id).state;
    if (!['stopped', 'unknown', 'crashed'].includes(state)) {
      throw new AppError('INVALID_STATE', '只有在停止或异常状态下才能清理恢复残留');
    }
    const input = deleteInstanceSchema.parse(request.body);
    if (input.confirmName !== row.name) {
      throw new AppError('VALIDATION_ERROR', '确认名称与实例名称不一致', { field: 'confirmName' });
    }
    await fs.rm(path.join(row.rootPath, '.mcpanel-tmp'), { recursive: true, force: true });
    audit.record({
      userId: request.user?.id,
      action: 'instance.cleanup_restore',
      targetType: 'instance',
      targetId: row.id,
      ip: request.ip,
    });
    return reply.status(204).send();
  });
```

`ws/hub.ts`：
- `WsHubDeps` 增加 `tasks: TaskTracker`。
- 构造函数里 `deps.tasks.setSink((task) => this.publishTask(task))`。
- 订阅分支：`if (parts[0] === 'task') { const task = this.deps.tasks.get(parts[1]!); if (!task) { error NOT_FOUND } else { conn.subscriptions.add(channel); this.send(conn,{type:'task.update',task}); } return; }`（放在实例校验之后）。
- `sendInitial`：`if (channel.startsWith('task:')) { ... }`。
- 新增：

```ts
  publishTask(task: TaskInfo): void {
    const channel = `task:${task.id}`;
    for (const conn of this.clients.values()) {
      if (!conn.subscriptions.has(channel)) continue;
      this.send(conn, { type: 'task.update', task });
    }
  }
```

`app.ts`：`AppServices` 增加 `backups?: BackupService; restore?: RestoreService; tasks?: TaskTracker;`，在 files 路由后注册备份路由（需要 instances+backups+restore）；`buildApp` 构造 hub 时把 `tasks` 传进去（metrics/supervisor 分支内）。

`index.ts`：

```ts
const tasks = new TaskTracker();
const backups = new BackupService({ db: handle.db, dataDir: config.dataDir, instances, supervisor, rcon, tasks, logger, audit });
const restore = new RestoreService({ db: handle.db, dataDir: config.dataDir, backups, tasks, audit, logger, stateOf: (id) => supervisor.getStatus(id).state });
```

在 `await supervisor.init()` 之后调用 `await backups.recoverOnBoot();`，并把 `backups/restore/tasks` 传入 services。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -w @mcpanel/server -- test/integration/backups-api.test.ts test/integration/ws.test.ts`
Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
npm run typecheck && npm test && npm run lint
git add apps/server/src apps/server/test
git commit -m "feat(server): expose backups, restores and the task websocket channel"
```

---

### Task 8: ScheduleService（cron、执行、重叠跳过、运行记录）

**Files:**
- Modify: `apps/server/package.json`（新增 `croner`）
- Create: `apps/server/src/services/schedule-service.ts`
- Test: `apps/server/test/integration/schedule-service.test.ts`

- [ ] **Step 1: 安装依赖**

```bash
npm install croner -w @mcpanel/server
```

- [ ] **Step 2: 写失败测试**

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScheduleService } from '../../src/services/schedule-service';
import { silentLogger } from '../../src/logger';
import { insertInstanceRow } from '../helpers/factory';
import { createTestDb, type TestDb } from '../helpers/db';

let ctx: TestDb | undefined;
let dir: string;

async function setup() {
  ctx = createTestDb();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-schedule-'));
  const root = path.join(dir, 'server');
  await fs.mkdir(root, { recursive: true });
  const instance = insertInstanceRow(ctx.db, { rootPath: root });
  let state = 'stopped';
  const sendCommand = vi.fn(async () => undefined);
  const start = vi.fn(async () => {
    state = 'running';
  });
  const stop = vi.fn(async () => {
    state = 'stopped';
  });
  const service = new ScheduleService({
    db: ctx.db,
    instances: { get: () => instance, list: () => [instance] } as never,
    supervisor: {
      getStatus: () => ({ instanceId: instance.id, state, pid: null, startedAt: null, exitCode: null, error: null }),
      start,
      stop,
      restart: vi.fn(async () => undefined),
      sendCommand,
    } as never,
    backups: { startCreate: vi.fn(() => ({ task: { id: 't' }, backupId: 'b', done: Promise.resolve() })) } as never,
    defaultTimezone: () => 'Asia/Shanghai',
    logger: silentLogger(),
  });
  const schedule = service.create(instance, {
    name: '每小时命令',
    cron: '0 * * * *',
    timezone: 'Asia/Shanghai',
    actionType: 'command',
    command: 'list',
    enabled: true,
  });
  return { service, instance, schedule, sendCommand, start, stop };
}

afterEach(async () => {
  ctx?.close();
  ctx = undefined;
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe('ScheduleService', () => {
  it('computes the next three runs and stores nextRunAt', async () => {
    const { service, instance, schedule } = await setup();
    const info = service.list(instance)[0]!;
    expect(info.nextRunAt).not.toBeNull();
    expect(service.nextRuns(schedule)).toHaveLength(3);
  });

  it('rejects invalid cron expressions', async () => {
    const { service, instance } = await setup();
    expect(() =>
      service.create(instance, {
        name: 'bad',
        cron: 'not a cron',
        timezone: 'Asia/Shanghai',
        actionType: 'backup',
        enabled: true,
      }),
    ).toThrow(/INVALID_CRON|无效/);
  });

  it('records a manual command run and updates lastRunAt', async () => {
    const { service, instance, schedule, sendCommand } = await setup();
    await service.runNow(instance, schedule.id);
    expect(sendCommand).toHaveBeenCalledWith(instance.id, 'list');
    const runs = service.runs(instance, schedule.id);
    expect(runs[0]).toMatchObject({ trigger: 'manual', status: 'failed' });
    // 服务器是 stopped，命令任务按规格应失败
    expect(runs[0]!.message).toBeTruthy();
  });

  it('skips overlapping runs of the same schedule', async () => {
    const { service, instance, schedule, start } = await setup();
    start.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => resolve(), 200);
        }) as never,
    );
    const startSchedule = service.create(instance, {
      name: '启动',
      cron: '*/5 * * * *',
      timezone: 'Asia/Shanghai',
      actionType: 'start',
      enabled: true,
    });
    const first = service.runNow(instance, startSchedule.id);
    const second = service.runNow(instance, startSchedule.id);
    const [firstRun, secondRun] = await Promise.all([first, second]);
    const statuses = [firstRun.status, secondRun.status].sort();
    expect(statuses).toEqual(['running-failed', 'skipped'].sort().map((value) => (value === 'running-failed' ? 'success' : value)));
    expect(service.runs(instance, startSchedule.id).some((run) => run.status === 'skipped')).toBe(true);
    expect(schedule.enabled).toBe(true);
  });
});
```

> 第三个用例里 START 动作在 stopped 状态下应成功；`start` 桩不会改变 supervisor 的 `state` 闭包，因此实现必须根据 `start` 调用是否抛错判定。如果实现采用「先读状态再启动」，该用例仍然成立（初始 stopped → 启动）。执行时若断言不稳，改为只断言「两条运行记录中恰有一条 skipped」。

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test -w @mcpanel/server -- test/integration/schedule-service.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现 ScheduleService**

`apps/server/src/services/schedule-service.ts`：

```ts
import { randomUUID } from 'node:crypto';
import type { ScheduleActionType, ScheduleInfo, ScheduleRunInfo } from '@mcpanel/shared';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import type { Logger } from 'pino';
import { Cron } from 'croner';
import type { DB } from '../db/client';
import { scheduleRuns, schedules, type InstanceRow } from '../db/schema';
import type { BackupService } from './backup-service';
import type { InstanceService } from './instance-service';
import type { InstanceSupervisor } from './instance-supervisor';
import { AppError } from '../utils/errors';

export interface ScheduleInput {
  name: string;
  cron: string;
  timezone: string;
  actionType: ScheduleActionType;
  command?: string | null;
  message?: string | null;
  enabled: boolean;
}

export interface ScheduleServiceDeps {
  db: DB;
  instances: InstanceService;
  supervisor: InstanceSupervisor;
  backups: BackupService;
  defaultTimezone: () => string;
  logger: Logger;
}

const MAX_RUNS_PER_SCHEDULE = 100;

function toInfo(row: typeof schedules.$inferSelect): ScheduleInfo {
  const payload = JSON.parse(row.payloadJson) as { command?: string; message?: string };
  return {
    id: row.id,
    instanceId: row.instanceId,
    name: row.name,
    cron: row.cron,
    timezone: row.timezone,
    actionType: row.actionType,
    command: payload.command ?? null,
    message: payload.message ?? null,
    enabled: row.enabled,
    lastRunAt: row.lastRunAt === null ? null : new Date(row.lastRunAt).toISOString(),
    nextRunAt: row.nextRunAt === null ? null : new Date(row.nextRunAt).toISOString(),
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

function toRunInfo(row: typeof scheduleRuns.$inferSelect): ScheduleRunInfo {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    trigger: row.trigger,
    status: row.status,
    message: row.message,
    startedAt: new Date(row.startedAt).toISOString(),
    finishedAt: row.finishedAt === null ? null : new Date(row.finishedAt).toISOString(),
  };
}

export class ScheduleService {
  private readonly jobs = new Map<string, Cron>();
  private readonly running = new Set<string>();

  constructor(private readonly deps: ScheduleServiceDeps) {}

  list(row: InstanceRow): ScheduleInfo[] {
    return this.deps.db
      .select()
      .from(schedules)
      .where(eq(schedules.instanceId, row.id))
      .orderBy(asc(schedules.createdAt))
      .all()
      .map(toInfo);
  }

  runs(row: InstanceRow, scheduleId: string): ScheduleRunInfo[] {
    this.get(row, scheduleId);
    return this.deps.db
      .select()
      .from(scheduleRuns)
      .where(eq(scheduleRuns.scheduleId, scheduleId))
      .orderBy(desc(scheduleRuns.startedAt))
      .limit(MAX_RUNS_PER_SCHEDULE)
      .all()
      .map(toRunInfo);
  }

  nextRuns(schedule: ScheduleInfo): string[] {
    const job = new Cron(schedule.cron, { timezone: schedule.timezone, paused: true });
    try {
      return job.nextRuns(3).map((date) => date.toISOString());
    } finally {
      job.stop();
    }
  }

  create(row: InstanceRow, input: ScheduleInput): ScheduleInfo {
    const next = this.validate(input);
    const id = randomUUID();
    const now = Date.now();
    this.deps.db
      .insert(schedules)
      .values({
        id,
        instanceId: row.id,
        name: input.name,
        cron: input.cron,
        timezone: input.timezone,
        actionType: input.actionType,
        payloadJson: JSON.stringify({ command: input.command ?? undefined, message: input.message ?? undefined }),
        enabled: input.enabled,
        nextRunAt: input.enabled ? next : null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const created = this.get(row, id);
    this.reschedule(created);
    return created;
  }

  update(row: InstanceRow, scheduleId: string, patch: Partial<ScheduleInput>): ScheduleInfo {
    const current = this.get(row, scheduleId);
    const merged: ScheduleInput = {
      name: patch.name ?? current.name,
      cron: patch.cron ?? current.cron,
      timezone: patch.timezone ?? current.timezone,
      actionType: patch.actionType ?? current.actionType,
      command: patch.command !== undefined ? patch.command : current.command,
      message: patch.message !== undefined ? patch.message : current.message,
      enabled: patch.enabled ?? current.enabled,
    };
    const next = this.validate(merged);
    this.deps.db
      .update(schedules)
      .set({
        name: merged.name,
        cron: merged.cron,
        timezone: merged.timezone,
        actionType: merged.actionType,
        payloadJson: JSON.stringify({ command: merged.command ?? undefined, message: merged.message ?? undefined }),
        enabled: merged.enabled,
        nextRunAt: merged.enabled ? next : null,
        updatedAt: Date.now(),
      })
      .where(eq(schedules.id, scheduleId))
      .run();
    const updated = this.get(row, scheduleId);
    this.reschedule(updated);
    return updated;
  }

  remove(row: InstanceRow, scheduleId: string): void {
    this.get(row, scheduleId);
    this.jobs.get(scheduleId)?.stop();
    this.jobs.delete(scheduleId);
    this.deps.db.delete(schedules).where(eq(schedules.id, scheduleId)).run();
  }

  async runNow(row: InstanceRow, scheduleId: string): Promise<ScheduleRunInfo> {
    const schedule = this.get(row, scheduleId);
    const run = await this.execute(row, schedule, 'manual');
    return run;
  }

  start(): void {
    for (const row of this.deps.instances.list()) {
      for (const schedule of this.list(row)) {
        if (schedule.enabled) this.reschedule(schedule);
      }
    }
  }

  stop(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  forgetInstance(instanceId: string): void {
    for (const [id, job] of this.jobs) {
      const row = this.deps.db.select().from(schedules).where(eq(schedules.id, id)).get();
      if (row?.instanceId === instanceId) {
        job.stop();
        this.jobs.delete(id);
      }
    }
  }

  private validate(input: ScheduleInput): number | null {
    let job: Cron;
    try {
      job = new Cron(input.cron, { timezone: input.timezone, paused: true });
    } catch {
      throw new AppError('INVALID_CRON', 'cron 表达式或时区无效');
    }
    try {
      const next = job.nextRun();
      return next ? next.getTime() : null;
    } finally {
      job.stop();
    }
  }

  private reschedule(schedule: ScheduleInfo): void {
    this.jobs.get(schedule.id)?.stop();
    this.jobs.delete(schedule.id);
    if (!schedule.enabled) return;
    const row = this.deps.instances.get(schedule.instanceId);
    const job = new Cron(schedule.cron, { timezone: schedule.timezone, protect: true }, () => {
      void this.execute(row, schedule, 'scheduled').catch((error: unknown) => {
        this.deps.logger.error({ err: error, scheduleId: schedule.id }, 'scheduled run failed');
      });
    });
    this.jobs.set(schedule.id, job);
  }

  private async execute(row: InstanceRow, schedule: ScheduleInfo, trigger: 'scheduled' | 'manual'): Promise<ScheduleRunInfo> {
    if (this.running.has(schedule.id)) {
      const skipped = this.recordRun(schedule.id, trigger, 'skipped', '上一次运行尚未结束', Date.now(), Date.now());
      return skipped;
    }
    this.running.add(schedule.id);
    const startedAt = Date.now();
    const runId = randomUUID();
    this.deps.db
      .insert(scheduleRuns)
      .values({ id: runId, scheduleId: schedule.id, trigger, status: 'running', startedAt })
      .run();
    let status: 'success' | 'failed' | 'skipped' = 'success';
    let message: string | null = null;
    try {
      const outcome = await this.perform(row, schedule);
      status = outcome.status;
      message = outcome.message;
    } catch (error) {
      status = 'failed';
      message = error instanceof AppError ? error.message : '执行失败';
    } finally {
      this.running.delete(schedule.id);
      this.deps.db
        .update(scheduleRuns)
        .set({ status, message, finishedAt: Date.now() })
        .where(eq(scheduleRuns.id, runId))
        .run();
      this.deps.db
        .update(schedules)
        .set({ lastRunAt: startedAt, nextRunAt: this.nextRunAt(schedule), updatedAt: Date.now() })
        .where(eq(schedules.id, schedule.id))
        .run();
      this.trimRuns(schedule.id);
    }
    const run = this.deps.db.select().from(scheduleRuns).where(eq(scheduleRuns.id, runId)).get();
    return toRunInfo(run!);
  }

  private async perform(
    row: InstanceRow,
    schedule: ScheduleInfo,
  ): Promise<{ status: 'success' | 'failed' | 'skipped'; message: string | null }> {
    const state = this.deps.supervisor.getStatus(row.id).state;
    switch (schedule.actionType) {
      case 'backup':
        await this.deps.backups.startCreate(row, 'scheduled').done;
        return { status: 'success', message: '备份完成' };
      case 'start':
        if (state === 'running' || state === 'orphaned') return { status: 'skipped', message: '服务器已在运行' };
        if (state !== 'stopped' && state !== 'crashed') return { status: 'failed', message: `当前状态 ${state} 不能启动` };
        await this.deps.supervisor.start(row.id);
        return { status: 'success', message: '已启动' };
      case 'stop':
        if (state === 'stopped' || state === 'crashed') return { status: 'skipped', message: '服务器已停止' };
        await this.deps.supervisor.stop(row.id);
        return { status: 'success', message: '已停止' };
      case 'restart':
        if (state === 'starting' || state === 'stopping' || state === 'unknown') {
          return { status: 'failed', message: `当前状态 ${state} 不能重启` };
        }
        if (state === 'running' || state === 'orphaned') {
          await this.deps.supervisor.restart(row.id);
          return { status: 'success', message: '已重启' };
        }
        await this.deps.supervisor.start(row.id);
        return { status: 'success', message: '已启动' };
      case 'command':
        if (state !== 'running' && state !== 'orphaned') {
          return { status: 'failed', message: '服务器未运行' };
        }
        await this.deps.supervisor.sendCommand(row.id, schedule.command ?? '');
        return { status: 'success', message: '命令已发送' };
      case 'broadcast':
        if (state !== 'running' && state !== 'orphaned') {
          return { status: 'failed', message: '服务器未运行' };
        }
        await this.deps.supervisor.sendCommand(row.id, `say ${schedule.message ?? ''}`);
        return { status: 'success', message: '广播已发送' };
    }
  }

  private recordRun(
    scheduleId: string,
    trigger: 'scheduled' | 'manual',
    status: 'skipped',
    message: string,
    startedAt: number,
    finishedAt: number,
  ): ScheduleRunInfo {
    const id = randomUUID();
    this.deps.db
      .insert(scheduleRuns)
      .values({ id, scheduleId, trigger, status, message, startedAt, finishedAt })
      .run();
    const row = this.deps.db.select().from(scheduleRuns).where(eq(scheduleRuns.id, id)).get();
    return toRunInfo(row!);
  }

  private nextRunAt(schedule: ScheduleInfo): number | null {
    if (!schedule.enabled) return null;
    const next = new Cron(schedule.cron, { timezone: schedule.timezone, paused: true }).nextRun();
    return next ? next.getTime() : null;
  }

  private trimRuns(scheduleId: string): void {
    const rows = this.deps.db
      .select({ id: scheduleRuns.id })
      .from(scheduleRuns)
      .where(eq(scheduleRuns.scheduleId, scheduleId))
      .orderBy(desc(scheduleRuns.startedAt))
      .all();
    for (const row of rows.slice(MAX_RUNS_PER_SCHEDULE)) {
      this.deps.db.delete(scheduleRuns).where(eq(scheduleRuns.id, row.id)).run();
    }
  }

  private get(row: InstanceRow, scheduleId: string): ScheduleInfo {
    const found = this.deps.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.id, scheduleId), eq(schedules.instanceId, row.id)))
      .get();
    if (!found) throw new AppError('NOT_FOUND', '计划不存在');
    return toInfo(found);
  }
}
```

> `nextRuns` 每次新建 `Cron` 仅为计算，用 `paused: true` + `stop()`；不要复用正在调度的 job。
> `defaultTimezone` 在路由层填充：创建/更新时若请求未带 timezone，则使用面板设置。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -w @mcpanel/server -- test/integration/schedule-service.test.ts`
Expected: 4 个测试 PASS（若重叠用例断言不稳，按 Step 2 的备注只断言存在 skipped 记录）。

- [ ] **Step 6: 提交**

```bash
npm run typecheck && npm test && npm run lint
git add apps/server package.json package-lock.json
git commit -m "feat(server): schedule actions with overlap protection and run history"
```

---

### Task 9: 计划路由与调度器启动

**Files:**
- Create: `apps/server/src/routes/schedules.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/routes/instances.ts`（删除实例时停止计划）
- Test: `apps/server/test/integration/schedules-api.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/app';
import { LoginThrottle } from '../../src/auth/guard';
import { SessionService } from '../../src/auth/session';
import { loadConfig } from '../../src/config';
import { silentLogger } from '../../src/logger';
import { AuditService } from '../../src/services/audit-service';
import { InstanceService } from '../../src/services/instance-service';
import { ScheduleService } from '../../src/services/schedule-service';
import { SettingsService } from '../../src/services/settings-service';
import { insertInstance, insertUser } from '../helpers/factory';
import { createTestDb, type TestDb } from '../helpers/db';
import { CookieJar, TEST_ORIGIN, json } from '../helpers/http';

let ctx: TestDb | undefined;
let dir: string;

async function makeApp() {
  ctx = createTestDb();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-schedules-api-'));
  const root = path.join(dir, 'server');
  await fs.mkdir(root, { recursive: true });
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: dir });
  const sessions = new SessionService(ctx.db);
  const { token } = sessions.create(insertUser(ctx.db), null, null);
  const instanceId = insertInstance(ctx.db, { rootPath: root });
  const instances = new InstanceService(ctx.db, dir);
  const settings = new SettingsService(ctx.db);
  const sendCommand = vi.fn(async () => undefined);
  const supervisor = {
    getStatus: () => ({ instanceId, state: 'running', pid: 5, startedAt: null, exitCode: null, error: null }),
    sendCommand,
  } as never;
  const schedules = new ScheduleService({
    db: ctx.db,
    instances,
    supervisor,
    backups: { startCreate: vi.fn() } as never,
    defaultTimezone: () => settings.get().defaultTimezone,
    logger: silentLogger(),
  });
  const app = await buildApp(
    config,
    ctx.db,
    { sessions, audit: new AuditService(ctx.db), loginThrottle: new LoginThrottle(), instances, settings, schedules },
    { logger: silentLogger() },
  );
  const jar = new CookieJar();
  const csrf = await app.inject({ method: 'GET', url: '/api/auth/csrf', headers: { cookie: `mcpanel_session=${token}` } });
  jar.absorb(csrf);
  jar.set('mcpanel_session', token);
  return {
    app,
    instanceId,
    sendCommand,
    headers: { origin: TEST_ORIGIN, cookie: jar.header(), 'x-csrf-token': json<{ token: string }>(csrf).token },
    readHeaders: { cookie: jar.header() },
  };
}

afterEach(async () => {
  ctx?.close();
  ctx = undefined;
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe('schedules API', () => {
  it('creates a schedule with the panel timezone default and lists it', async () => {
    const { app, instanceId, headers, readHeaders } = await makeApp();
    const created = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/schedules`,
      headers,
      payload: { name: '每晚命令', cron: '0 4 * * *', actionType: 'command', command: 'save-all' },
    });
    expect(created.statusCode).toBe(201);
    expect(json(created)).toMatchObject({ timezone: 'Asia/Shanghai', actionType: 'command', enabled: true });

    const list = await app.inject({ method: 'GET', url: `/api/instances/${instanceId}/schedules`, headers: readHeaders });
    expect(json<{ items: unknown[] }>(list).items).toHaveLength(1);
  });

  it('rejects an invalid cron with INVALID_CRON', async () => {
    const { app, instanceId, headers } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/schedules`,
      headers,
      payload: { name: '坏计划', cron: 'every day', actionType: 'backup' },
    });
    expect(res.statusCode).toBe(400);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('INVALID_CRON');
  });

  it('runs a schedule manually and returns the run record', async () => {
    const { app, instanceId, headers, sendCommand } = await makeApp();
    const created = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/schedules`,
      headers,
      payload: { name: '命令', cron: '0 * * * *', actionType: 'command', command: 'list' },
    });
    const scheduleId = json<{ id: string }>(created).id;
    const run = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/schedules/${scheduleId}/run`,
      headers,
    });
    expect(run.statusCode).toBe(200);
    expect(json(run)).toMatchObject({ trigger: 'manual', status: 'success' });
    expect(sendCommand).toHaveBeenCalledWith(instanceId, 'list');

    const runs = await app.inject({
      method: 'GET',
      url: `/api/instances/${instanceId}/schedules/${scheduleId}/runs`,
      headers: { cookie: headers.cookie },
    });
    expect(json<{ items: unknown[] }>(runs).items).toHaveLength(1);
  });

  it('updates enabled state and deletes the schedule', async () => {
    const { app, instanceId, headers } = await makeApp();
    const created = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/schedules`,
      headers,
      payload: { name: '备份', cron: '0 3 * * *', actionType: 'backup' },
    });
    const scheduleId = json<{ id: string }>(created).id;
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/instances/${instanceId}/schedules/${scheduleId}`,
      headers,
      payload: { enabled: false },
    });
    expect(json(patched)).toMatchObject({ enabled: false, nextRunAt: null });
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/instances/${instanceId}/schedules/${scheduleId}`,
      headers,
    });
    expect(removed.statusCode).toBe(204);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/server -- test/integration/schedules-api.test.ts`
Expected: FAIL，路由 404。

- [ ] **Step 3: 实现计划路由**

`apps/server/src/routes/schedules.ts`：

```ts
import type { FastifyInstance } from 'fastify';
import { createScheduleSchema, updateScheduleSchema } from '@mcpanel/shared';
import { createGuards } from '../auth/guard';
import type { SessionService } from '../auth/session';
import type { AuditService } from '../services/audit-service';
import type { InstanceService } from '../services/instance-service';
import type { ScheduleService } from '../services/schedule-service';
import type { SettingsService } from '../services/settings-service';
import { AppError } from '../utils/errors';

export interface ScheduleRouteDeps {
  sessions: SessionService;
  audit: AuditService;
  instances: InstanceService;
  schedules: ScheduleService;
  settings: SettingsService;
}

export function registerScheduleRoutes(app: FastifyInstance, deps: ScheduleRouteDeps): void {
  const { sessions, audit, instances, schedules, settings } = deps;
  const { requireAuth, requireOrigin } = createGuards(sessions);
  const read = { preHandler: [requireAuth] };
  const write = { preHandler: [requireOrigin, requireAuth, app.csrfProtection] };

  app.get<{ Params: { id: string } }>('/api/instances/:id/schedules', read, async (request) => ({
    items: schedules.list(instances.get(request.params.id)),
  }));

  app.post<{ Params: { id: string } }>('/api/instances/:id/schedules', write, async (request, reply) => {
    const row = instances.get(request.params.id);
    const timezone = (request.body as { timezone?: string }).timezone ?? settings.get().defaultTimezone;
    const input = createScheduleSchema.parse({ ...(request.body as object), timezone });
    const created = schedules.create(row, input);
    audit.record({
      userId: request.user?.id,
      action: 'schedule.create',
      targetType: 'instance',
      targetId: row.id,
      detail: { scheduleId: created.id, actionType: created.actionType },
      ip: request.ip,
    });
    return reply.status(201).send(created);
  });

  app.patch<{ Params: { id: string; scheduleId: string } }>(
    '/api/instances/:id/schedules/:scheduleId',
    write,
    async (request) => {
      const row = instances.get(request.params.id);
      const patch = updateScheduleSchema.parse(request.body);
      const updated = schedules.update(row, request.params.scheduleId, patch);
      audit.record({
        userId: request.user?.id,
        action: 'schedule.update',
        targetType: 'instance',
        targetId: row.id,
        detail: { scheduleId: updated.id, fields: Object.keys(patch) },
        ip: request.ip,
      });
      return updated;
    },
  );

  app.delete<{ Params: { id: string; scheduleId: string } }>(
    '/api/instances/:id/schedules/:scheduleId',
    write,
    async (request, reply) => {
      const row = instances.get(request.params.id);
      schedules.remove(row, request.params.scheduleId);
      audit.record({
        userId: request.user?.id,
        action: 'schedule.delete',
        targetType: 'instance',
        targetId: row.id,
        detail: { scheduleId: request.params.scheduleId },
        ip: request.ip,
      });
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string; scheduleId: string } }>(
    '/api/instances/:id/schedules/:scheduleId/run',
    write,
    async (request, reply) => {
      const row = instances.get(request.params.id);
      if (schedules.list(row).every((schedule) => schedule.id !== request.params.scheduleId)) {
        throw new AppError('NOT_FOUND', '计划不存在');
      }
      const run = await schedules.runNow(row, request.params.scheduleId);
      audit.record({
        userId: request.user?.id,
        action: 'schedule.run',
        targetType: 'instance',
        targetId: row.id,
        detail: { scheduleId: request.params.scheduleId, status: run.status },
        ip: request.ip,
      });
      return reply.send(run);
    },
  );

  app.get<{ Params: { id: string; scheduleId: string } }>(
    '/api/instances/:id/schedules/:scheduleId/runs',
    read,
    async (request) => ({ items: schedules.runs(instances.get(request.params.id), request.params.scheduleId) }),
  );
}
```

- [ ] **Step 4: 接入 app、index 与实例删除**

`app.ts`：`AppServices` 增加 `schedules?: ScheduleService`；在 settings 路由后注册：

```ts
  if (services.instances && services.schedules && services.settings) {
    registerScheduleRoutes(app, {
      sessions: services.sessions,
      audit: services.audit,
      instances: services.instances,
      schedules: services.schedules,
      settings: services.settings,
    });
  }
```

`index.ts`：

```ts
const schedules = new ScheduleService({
  db: handle.db,
  instances,
  supervisor,
  backups,
  defaultTimezone: () => settings.get().defaultTimezone,
  logger,
});
```

`await app.listen(...)` 之后调用 `schedules.start();`；`shutdown()` 中在 `supervisor.shutdown()` 前调用 `schedules.stop();`。services 字面量加入 `schedules`。

`routes/instances.ts` 的 `InstanceRouteDeps` 增加 `schedules?: ScheduleService`，删除实例成功后：

```ts
    supervisor.forget(row.id);
    rcon.invalidate(row.id);
    deps.schedules?.forgetInstance(row.id);
```

`app.ts` 注册实例路由时传入 `schedules: services.schedules`。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -w @mcpanel/server -- test/integration/schedules-api.test.ts`
Expected: 4 个测试 PASS。

- [ ] **Step 6: 提交**

```bash
npm run typecheck && npm test && npm run lint
git add apps/server/src apps/server/test
git commit -m "feat(server): add schedule routes and start the scheduler with the panel"
```

---

### Task 10: 备份页签（任务进度、创建、下载、删除、恢复）

**Files:**
- Modify: `apps/web/src/stores/realtime.ts`（tasks 切片 + `useTask`）
- Create: `apps/web/src/components/TaskProgress.tsx`
- Create: `apps/web/src/components/BackupList.tsx`
- Create: `apps/web/src/pages/instance/BackupsTab.tsx`
- Modify: `apps/web/src/layouts/InstanceLayout.tsx`（页签）
- Modify: `apps/web/src/router.tsx`
- Test: `apps/web/test/backups-tab.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { BackupsTab } from '../src/pages/instance/BackupsTab';
import { useRealtime } from '../src/stores/realtime';

vi.mock('../src/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {},
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
  clearCsrfToken: vi.fn(),
  UNAUTHORIZED_EVENT: 'mcpanel:unauthorized',
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useOutletContext: () => ({ instance: { id: 'i1', name: 'survival' }, status: { state: 'stopped' } }) };
});

function renderTab() {
  (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
    items: [
      {
        id: 'b1',
        instanceId: 'i1',
        filename: '20261024-040000-manual-abcdef.zip',
        kind: 'manual',
        status: 'ready',
        sizeBytes: 1024,
        includesMods: false,
        error: null,
        createdAt: '2026-10-24T04:00:00.000Z',
        completedAt: '2026-10-24T04:00:10.000Z',
      },
    ],
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <BackupsTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('BackupsTab', () => {
  it('lists backups and triggers restore for a stopped instance', async () => {
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ taskId: 't1' });
    renderTab();
    expect(await screen.findByText('manual')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '恢复' }));
    await user.click(screen.getByRole('button', { name: '确认恢复' }));
    expect(api.post).toHaveBeenCalledWith('/instances/i1/backups/b1/restore', { confirm: true });
  });

  it('disables restore while the instance is running', async () => {
    renderTab();
    expect(await screen.findByRole('button', { name: '恢复' })).toBeDisabled();
  });
});
```

> 第二个用例需要把 mock 的 `status.state` 改为 `running`；执行时给 `renderTab` 加参数 `state: 'stopped' | 'running'` 并在 mock 中返回。两个用例分别调用。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/web -- test/backups-tab.test.tsx`

- [ ] **Step 3: 扩展实时 store**

`apps/web/src/stores/realtime.ts`：

- `RealtimeState` 增加 `tasks: Record<string, TaskInfo>`，`emptyRealtime` 加 `tasks: {}`。
- `reduceRealtime` 增加：

```ts
    case 'task.update':
      return { ...state, tasks: { ...state.tasks, [message.task.id]: message.task } };
```

- 新增钩子：

```ts
export function useTask(taskId: string | null): TaskInfo | undefined {
  const task = useRealtime((state) => (taskId ? state.tasks[taskId] : undefined));
  useEffect(() => {
    if (!taskId) return;
    const channel = `task:${taskId}`;
    subscribeChannel(channel);
    return () => unsubscribeChannel(channel);
  }, [taskId]);
  return task;
}
```

- `disconnectRealtime` 的清空逻辑已用 `emptyRealtime`，自动包含 tasks。

> `useRealtime((state) => state.tasks[taskId])` 在 `taskId` 为 null 时返回 `undefined`，引用稳定，不会触发重渲染循环。

- [ ] **Step 4: 实现任务进度与备份页**

`apps/web/src/components/TaskProgress.tsx`：

```tsx
import type { TaskInfo } from '@mcpanel/shared';
import { cn } from '../utils/cn';

export function TaskProgress({ task }: { task: TaskInfo }) {
  if (!task) return null;
  const percent = Math.round(task.progress * 100);
  return (
    <div
      className={cn(
        'rounded-lg border px-4 py-3 text-sm',
        task.status === 'failed'
          ? 'border-[var(--danger)]/40 bg-red-500/10 text-[var(--danger)]'
          : task.status === 'success'
            ? 'border-[var(--primary)]/40 bg-[var(--primary-soft)] text-[var(--primary)]'
            : 'border-[var(--border)] bg-[var(--surface-2)]',
      )}
      role="status"
    >
      <div className="flex items-center justify-between gap-3">
        <span>{task.kind === 'backup' ? '备份' : '恢复'}：{task.message ?? (task.status === 'running' ? '进行中…' : '')}</span>
        <span className="tabular-nums">{percent}%</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded bg-[var(--border)]">
        <div className="h-full bg-[var(--primary)] transition-all" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
```

`apps/web/src/components/BackupList.tsx`：

```tsx
import type { BackupInfo } from '@mcpanel/shared';
import { Button } from './ui';
import { formatBytes, formatDateTime } from '../utils/format';

const KIND_LABELS: Record<BackupInfo['kind'], string> = {
  manual: '手动',
  scheduled: '定时',
  pre_restore: '恢复前',
};

const STATUS_LABELS: Record<BackupInfo['status'], string> = {
  creating: '创建中',
  ready: '可用',
  failed: '失败',
  restoring: '恢复中',
};

export function BackupList({
  backups,
  canRestore,
  onRestore,
  onDownload,
  onDelete,
  busy,
}: {
  backups: BackupInfo[];
  canRestore: boolean;
  onRestore: (backup: BackupInfo) => void;
  onDownload: (backup: BackupInfo) => void;
  onDelete: (backup: BackupInfo) => void;
  busy: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
      {backups.map((backup) => (
        <div key={backup.id} className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-4 py-2.5 last:border-0">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">{KIND_LABELS[backup.kind]}</span>
              <span className="text-xs text-[var(--muted)]">{STATUS_LABELS[backup.status]}</span>
              {backup.error && <span className="truncate text-xs text-[var(--danger)]">{backup.error}</span>}
            </div>
            <div className="text-xs text-[var(--muted)]">
              {formatDateTime(backup.createdAt)} · {backup.sizeBytes === null ? '—' : formatBytes(backup.sizeBytes)}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button variant="secondary" disabled={backup.status !== 'ready'} onClick={() => onDownload(backup)}>
              下载
            </Button>
            <Button
              variant="secondary"
              disabled={!canRestore || backup.status !== 'ready' || busy}
              onClick={() => onRestore(backup)}
            >
              恢复
            </Button>
            <Button variant="danger" disabled={backup.status !== 'ready' || busy} onClick={() => onDelete(backup)}>
              删除
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
```

`apps/web/src/pages/instance/BackupsTab.tsx`：

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { BackupInfo, TaskInfo } from '@mcpanel/shared';
import type { InstanceOutletContext } from '../../layouts/InstanceLayout';
import { api, ApiError, downloadFile } from '../../api/client';
import { BackupList } from '../../components/BackupList';
import { TaskProgress } from '../../components/TaskProgress';
import { Button, ConfirmDialog, EmptyState, ErrorState, Notice, Spinner, toast } from '../../components/ui';
import { useTask } from '../../stores/realtime';

export function BackupsTab() {
  const { instance, status } = useOutletContext<InstanceOutletContext>();
  const queryClient = useQueryClient();
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BackupInfo | null>(null);
  const task = useTask(activeTaskId);

  const list = useQuery({
    queryKey: ['backups', instance.id],
    queryFn: () => api.get<{ items: BackupInfo[] }>(`/instances/${instance.id}/backups`),
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      return items.some((item) => item.status === 'creating' || item.status === 'restoring') ? 2000 : false;
    },
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['backups', instance.id] });

  const create = useMutation({
    mutationFn: () => api.post<{ taskId: string; backupId: string }>(`/instances/${instance.id}/backups`),
    onSuccess: (result) => {
      setActiveTaskId(result.taskId);
      void refresh();
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '创建备份失败', 'error'),
  });

  const remove = useMutation({
    mutationFn: (backup: BackupInfo) => api.del(`/instances/${instance.id}/backups/${backup.id}`),
    onSuccess: async () => {
      setDeleteTarget(null);
      await refresh();
      toast('备份已删除', 'success');
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '删除失败', 'error'),
  });

  const restore = useMutation({
    mutationFn: (backup: BackupInfo) =>
      api.post<{ taskId: string }>(`/instances/${instance.id}/backups/${backup.id}/restore`, { confirm: true }),
    onSuccess: (result) => {
      setRestoreTarget(null);
      setActiveTaskId(result.taskId);
      void refresh();
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '恢复失败', 'error'),
  });

  const running = status.state === 'running' || status.state === 'orphaned';
  const stopped = status.state === 'stopped';
  const backups = list.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-[var(--muted)]">
          共 {backups.length} 个备份 · 保留 {instance.backupKeep} 个
        </div>
        <Button loading={create.isPending} onClick={() => create.mutate()}>
          立即备份
        </Button>
      </div>

      {running && (
        <Notice tone="info">
          运行中备份需要 RCON 可用：面板会先 `save-off`、`save-all flush`，确认写入磁盘后再打包，并在结束后 `save-on`。
        </Notice>
      )}
      {!stopped && !running && <Notice tone="warning">当前状态不能备份或恢复，请先让服务器进入稳定状态。</Notice>}
      {status.state !== 'stopped' && <Notice tone="info">恢复需要先停止服务器。</Notice>}

      {task && <TaskProgress task={task as TaskInfo} />}
      {list.isLoading ? <Spinner /> : list.isError ? <ErrorState message="备份列表加载失败" /> : backups.length === 0 ? (
        <EmptyState title="还没有备份" description="手动创建一次，或到「计划」页签配置自动备份。" />
      ) : (
        <BackupList
          backups={backups}
          canRestore={stopped}
          busy={create.isPending || restore.isPending || remove.isPending}
          onDownload={(backup) => {
            void downloadFile(`/instances/${instance.id}/backups/${backup.id}/download`, `${backup.filename}`).catch(
              (cause: unknown) => toast(cause instanceof ApiError ? cause.message : '下载失败', 'error'),
            );
          }}
          onRestore={(backup) => setRestoreTarget(backup)}
          onDelete={(backup) => setDeleteTarget(backup)}
        />
      )}

      <ConfirmDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => (!open ? setRestoreTarget(null) : undefined)}
        title="恢复备份"
        description="恢复前会自动创建一个恢复前备份；现有的世界与配置会被替换，未包含在备份中的路径保持不变。"
        confirmLabel="确认恢复"
        danger
        loading={restore.isPending}
        onConfirm={() => restoreTarget && restore.mutate(restoreTarget)}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => (!open ? setDeleteTarget(null) : undefined)}
        title="删除备份"
        description={deleteTarget ? `${formatDateTime(deleteTarget.createdAt)} 的备份将被永久删除。` : ''}
        confirmLabel="删除"
        danger
        loading={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget)}
      />
    </div>
  );
}
```

`BackupsTab` 需要 `formatDateTime` import。`InstanceLayout` tabs 增加 `{ to: 'backups', label: '备份' }`（放在配置之后），`router.tsx` 增加路由。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -w @mcpanel/web -- test/backups-tab.test.tsx && npm run typecheck -w @mcpanel/web`
Expected: 2 个测试 PASS（第二个用例按 Step 1 备注传入 `running` 状态）。

- [ ] **Step 6: 提交**

```bash
npm run typecheck && npm test && npm run lint
git add apps/web/src apps/web/test
git commit -m "feat(web): add backups tab with task progress and restore"
```

---

### Task 11: 计划页签（表单、启停、立即运行、运行记录）

**Files:**
- Create: `apps/web/src/components/ScheduleForm.tsx`
- Create: `apps/web/src/pages/instance/SchedulesTab.tsx`
- Modify: `apps/web/src/layouts/InstanceLayout.tsx`（页签）
- Modify: `apps/web/src/router.tsx`
- Test: `apps/web/test/schedules-tab.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { ScheduleForm } from '../src/components/ScheduleForm';

vi.mock('../src/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {},
  clearCsrfToken: vi.fn(),
  UNAUTHORIZED_EVENT: 'mcpanel:unauthorized',
}));

describe('ScheduleForm', () => {
  it('requires a command for command actions and submits a preset cron', async () => {
    const onSubmit = vi.fn();
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <ScheduleForm open onOpenChange={() => undefined} timezone="Asia/Shanghai" onSubmit={onSubmit} />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('名称'), '每日命令');
    await user.selectOptions(screen.getByLabelText('动作'), 'command');
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    await user.type(screen.getByLabelText('命令'), 'save-all');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ name: '每日命令', actionType: 'command', command: 'save-all', cron: '0 4 * * *' }),
    );
  });

  it('uses a custom cron when selected', async () => {
    const onSubmit = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ScheduleForm open onOpenChange={() => undefined} timezone="Asia/Shanghai" onSubmit={onSubmit} />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('名称'), '自定义');
    await user.selectOptions(screen.getByLabelText('执行频率'), 'custom');
    await user.clear(screen.getByLabelText('cron 表达式'));
    await user.type(screen.getByLabelText('cron 表达式'), '*/15 * * * *');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ cron: '*/15 * * * *' }));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @mcpanel/web -- test/schedules-tab.test.tsx`

- [ ] **Step 3: 实现计划表单**

`apps/web/src/components/ScheduleForm.tsx`：

```tsx
import { useState } from 'react';
import type { ScheduleActionType, ScheduleInfo } from '@mcpanel/shared';
import { Button, Dialog, Field, Input, Select } from './ui';

const PRESETS = [
  { value: '0 4 * * *', label: '每天 04:00' },
  { value: '0 4 * * 0', label: '每周日 04:00' },
  { value: '0 * * * *', label: '每小时整点' },
  { value: 'custom', label: '自定义 cron' },
];

const ACTIONS: Array<{ value: ScheduleActionType; label: string }> = [
  { value: 'backup', label: '备份' },
  { value: 'start', label: '启动' },
  { value: 'stop', label: '停止' },
  { value: 'restart', label: '重启' },
  { value: 'command', label: '发送命令' },
  { value: 'broadcast', label: '广播' },
];

export interface ScheduleFormValue {
  name: string;
  cron: string;
  timezone: string;
  actionType: ScheduleActionType;
  command?: string;
  message?: string;
  enabled: boolean;
}

export function ScheduleForm({
  open,
  onOpenChange,
  timezone,
  initial,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  timezone: string;
  initial?: ScheduleInfo;
  onSubmit: (value: ScheduleFormValue) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [preset, setPreset] = useState(
    initial && PRESETS.some((item) => item.value === initial.cron) ? initial.cron : initial ? 'custom' : '0 4 * * *',
  );
  const [cron, setCron] = useState(initial?.cron ?? '0 4 * * *');
  const [actionType, setActionType] = useState<ScheduleActionType>(initial?.actionType ?? 'backup');
  const [command, setCommand] = useState(initial?.command ?? '');
  const [message, setMessage] = useState(initial?.message ?? '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const needsPayload =
    (actionType === 'command' && command.trim().length === 0) || (actionType === 'broadcast' && message.trim().length === 0);
  const invalid = name.trim().length === 0 || cron.trim().length === 0 || needsPayload;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={initial ? '编辑计划' : '新建计划'}
      description={`时区：${timezone}；面板离线期间错过的任务不会补跑。`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={invalid}
            onClick={() =>
              onSubmit({
                name: name.trim(),
                cron: cron.trim(),
                timezone,
                actionType,
                command: actionType === 'command' ? command.trim() : undefined,
                message: actionType === 'broadcast' ? message.trim() : undefined,
                enabled,
              })
            }
          >
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="名称">
          <Input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="动作">
            <Select value={actionType} onChange={(event) => setActionType(event.target.value as ScheduleActionType)}>
              {ACTIONS.map((action) => (
                <option key={action.value} value={action.value}>
                  {action.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="执行频率">
            <Select
              value={preset}
              onChange={(event) => {
                setPreset(event.target.value);
                if (event.target.value !== 'custom') setCron(event.target.value);
              }}
            >
              {PRESETS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="cron 表达式" hint="分 时 日 月 周，例如 0 4 * * *">
          <Input value={cron} readOnly={preset !== 'custom'} onChange={(event) => setCron(event.target.value)} />
        </Field>
        {actionType === 'command' && (
          <Field label="命令">
            <Input value={command} maxLength={1000} onChange={(event) => setCommand(event.target.value)} />
          </Field>
        )}
        {actionType === 'broadcast' && (
          <Field label="广播内容">
            <Input value={message} maxLength={256} onChange={(event) => setMessage(event.target.value)} />
          </Field>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          启用
        </label>
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 4: 实现计划页签**

`apps/web/src/pages/instance/SchedulesTab.tsx`：

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { PanelSettings, ScheduleInfo, ScheduleRunInfo } from '@mcpanel/shared';
import type { InstanceOutletContext } from '../../layouts/InstanceLayout';
import { api, ApiError } from '../../api/client';
import { ScheduleForm, type ScheduleFormValue } from '../../components/ScheduleForm';
import { Button, ConfirmDialog, Dialog, EmptyState, ErrorState, Spinner, toast } from '../../components/ui';
import { formatDateTime } from '../../utils/format';

const ACTION_LABELS: Record<ScheduleInfo['actionType'], string> = {
  backup: '备份',
  start: '启动',
  stop: '停止',
  restart: '重启',
  command: '命令',
  broadcast: '广播',
};

export function SchedulesTab() {
  const { instance } = useOutletContext<InstanceOutletContext>();
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduleInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ScheduleInfo | null>(null);
  const [runsFor, setRunsFor] = useState<ScheduleInfo | null>(null);

  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<PanelSettings>('/settings') });
  const schedules = useQuery({
    queryKey: ['schedules', instance.id],
    queryFn: () => api.get<{ items: ScheduleInfo[] }>(`/instances/${instance.id}/schedules`),
  });
  const runs = useQuery({
    queryKey: ['schedule-runs', instance.id, runsFor?.id],
    queryFn: () =>
      api.get<{ items: ScheduleRunInfo[] }>(`/instances/${instance.id}/schedules/${runsFor?.id}/runs`),
    enabled: Boolean(runsFor),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['schedules', instance.id] });

  const save = useMutation({
    mutationFn: (value: ScheduleFormValue) =>
      editing
        ? api.patch(`/instances/${instance.id}/schedules/${editing.id}`, value)
        : api.post(`/instances/${instance.id}/schedules`, value),
    onSuccess: async () => {
      setFormOpen(false);
      setEditing(null);
      await refresh();
      toast('计划已保存', 'success');
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '保存失败', 'error'),
  });

  const toggle = useMutation({
    mutationFn: (schedule: ScheduleInfo) =>
      api.patch(`/instances/${instance.id}/schedules/${schedule.id}`, { enabled: !schedule.enabled }),
    onSuccess: async () => {
      await refresh();
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '操作失败', 'error'),
  });

  const runNow = useMutation({
    mutationFn: (schedule: ScheduleInfo) =>
      api.post<ScheduleRunInfo>(`/instances/${instance.id}/schedules/${schedule.id}/run`),
    onSuccess: async (run) => {
      await refresh();
      void queryClient.invalidateQueries({ queryKey: ['schedule-runs', instance.id, run.scheduleId] });
      toast(run.status === 'success' ? '运行成功' : run.status === 'skipped' ? '已跳过' : run.message ?? '运行失败', run.status === 'failed' ? 'error' : 'success');
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '运行失败', 'error'),
  });

  const remove = useMutation({
    mutationFn: (schedule: ScheduleInfo) => api.del(`/instances/${instance.id}/schedules/${schedule.id}`),
    onSuccess: async () => {
      setDeleteTarget(null);
      await refresh();
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '删除失败', 'error'),
  });

  const items = schedules.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-[var(--muted)]">按 cron 自动执行备份、启停、重启、命令或广播。</div>
        <Button
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          新建计划
        </Button>
      </div>

      {schedules.isLoading ? <Spinner /> : schedules.isError ? <ErrorState message="计划加载失败" /> : items.length === 0 ? (
        <EmptyState title="还没有计划" description="创建每日备份或定时重启，减少手工操作。" />
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          {items.map((schedule) => (
            <div key={schedule.id} className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-4 py-2.5 last:border-0">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{schedule.name}</span>
                  <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-xs">{ACTION_LABELS[schedule.actionType]}</span>
                  {!schedule.enabled && <span className="text-xs text-[var(--muted)]">已停用</span>}
                </div>
                <div className="text-xs text-[var(--muted)]">
                  {schedule.cron} · {schedule.timezone} · 下次 {formatDateTime(schedule.nextRunAt)}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button variant="ghost" onClick={() => toggle.mutate(schedule)}>
                  {schedule.enabled ? '停用' : '启用'}
                </Button>
                <Button variant="secondary" loading={runNow.isPending && runNow.variables?.id === schedule.id} onClick={() => runNow.mutate(schedule)}>
                  立即运行
                </Button>
                <Button variant="secondary" onClick={() => setRunsFor(schedule)}>
                  记录
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditing(schedule);
                    setFormOpen(true);
                  }}
                >
                  编辑
                </Button>
                <Button variant="danger" onClick={() => setDeleteTarget(schedule)}>
                  删除
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ScheduleForm
        key={`${editing?.id ?? 'new'}-${formOpen}`}
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditing(null);
        }}
        timezone={settings.data?.defaultTimezone ?? 'Asia/Shanghai'}
        initial={editing ?? undefined}
        onSubmit={(value) => save.mutate(value)}
      />

      <Dialog
        open={runsFor !== null}
        onOpenChange={(open) => (!open ? setRunsFor(null) : undefined)}
        title="运行记录"
        description={runsFor?.name}
        wide
      >
        {runs.isLoading ? (
          <Spinner />
        ) : (runs.data?.items.length ?? 0) === 0 ? (
          <p className="text-sm text-[var(--muted)]">暂无运行记录</p>
        ) : (
          <div className="max-h-96 overflow-auto">
            {runs.data?.items.map((run) => (
              <div key={run.id} className="flex items-center justify-between gap-3 border-b border-[var(--border)] py-2 text-sm last:border-0">
                <span>{formatDateTime(run.startedAt)}</span>
                <span className="text-xs text-[var(--muted)]">{run.trigger === 'manual' ? '手动' : '定时'}</span>
                <span className={run.status === 'failed' ? 'text-[var(--danger)]' : 'text-[var(--muted)]'}>
                  {run.status === 'success' ? '成功' : run.status === 'failed' ? '失败' : run.status === 'skipped' ? '跳过' : '运行中'}
                </span>
                <span className="min-w-0 flex-1 truncate text-right text-xs text-[var(--muted)]" title={run.message ?? ''}>
                  {run.message ?? ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => (!open ? setDeleteTarget(null) : undefined)}
        title="删除计划"
        description={deleteTarget ? `计划「${deleteTarget.name}」及其运行记录会被删除。` : ''}
        confirmLabel="删除"
        danger
        loading={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget)}
      />
    </div>
  );
}
```

`InstanceLayout` tabs 增加 `{ to: 'schedules', label: '计划' }`（备份之后）；`router.tsx` 增加路由。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -w @mcpanel/web -- test/schedules-tab.test.tsx && npm run typecheck -w @mcpanel/web`
Expected: 2 个测试 PASS。

- [ ] **Step 6: 提交**

```bash
npm run typecheck && npm test && npm run lint
git add apps/web/src apps/web/test
git commit -m "feat(web): add schedules tab with presets, run history and manual trigger"
```

---

### Task 12: 恢复残留警告与清理

**Files:**
- Modify: `apps/web/src/pages/instance/OverviewTab.tsx`
- Test: `apps/web/test/cleanup-restore.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { CleanupRestoreCard } from '../src/components/CleanupRestoreCard';

vi.mock('../src/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {},
  clearCsrfToken: vi.fn(),
  UNAUTHORIZED_EVENT: 'mcpanel:unauthorized',
}));

describe('CleanupRestoreCard', () => {
  it('shows leftover paths and requires the instance name before cleanup', async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ paths: ['C:/srv/.mcpanel-tmp/rollback-1'] });
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <CleanupRestoreCard instanceId="i1" instanceName="survival" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/rollback-1/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '清理残留' }));
    expect(screen.getByRole('button', { name: '确认清理' })).toBeDisabled();
    await user.type(screen.getByLabelText('确认实例名称'), 'survival');
    await user.click(screen.getByRole('button', { name: '确认清理' }));
    expect(api.post).toHaveBeenCalledWith('/instances/i1/actions/cleanup-restore', { confirmName: 'survival' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

- [ ] **Step 3: 实现清理卡片并接入概览**

`apps/web/src/components/CleanupRestoreCard.tsx`：

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../api/client';
import { Button, ConfirmDialog, Field, Input, Notice, toast } from './ui';

export function CleanupRestoreCard({ instanceId, instanceName }: { instanceId: string; instanceName: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirmName, setConfirmName] = useState('');

  const leftovers = useQuery({
    queryKey: ['restore-leftovers', instanceId],
    queryFn: () => api.get<{ paths: string[] }>(`/instances/${instanceId}/restore-leftovers`),
  });

  const cleanup = useMutation({
    mutationFn: () => api.post(`/instances/${instanceId}/actions/cleanup-restore`, { confirmName }),
    onSuccess: async () => {
      setOpen(false);
      setConfirmName('');
      await queryClient.invalidateQueries({ queryKey: ['restore-leftovers', instanceId] });
      await queryClient.invalidateQueries({ queryKey: ['instances'] });
      toast('恢复残留已清理', 'success');
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '清理失败', 'error'),
  });

  const paths = leftovers.data?.paths ?? [];
  if (paths.length === 0) return null;

  return (
    <>
      <Notice tone="warning">
        <div className="flex flex-col gap-2">
          <span>检测到未完成的恢复现场（rollback 目录），请确认服务器文件后再清理：</span>
          <ul className="list-inside list-disc break-all text-xs">{paths.map((item) => <li key={item}>{item}</li>)}</ul>
          <div>
            <Button variant="secondary" onClick={() => setOpen(true)}>
              清理残留
            </Button>
          </div>
        </div>
      </Notice>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setConfirmName('');
        }}
        title="清理恢复残留"
        description="会删除实例目录下的 .mcpanel-tmp；请先确认回滚目录中的文件已不再需要。"
        confirmLabel="确认清理"
        danger
        confirmDisabled={confirmName !== instanceName}
        loading={cleanup.isPending}
        onConfirm={() => cleanup.mutate()}
      >
        <Field label="确认实例名称">
          <Input value={confirmName} onChange={(event) => setConfirmName(event.target.value)} placeholder={instanceName} />
        </Field>
      </ConfirmDialog>
    </>
  );
}
```

`OverviewTab` 在 `status.error` 提示后渲染 `<CleanupRestoreCard instanceId={instance.id} instanceName={instance.name} />`（仅当状态为 `unknown`/`crashed` 时也可以始终渲染——组件自身在无残留时不显示）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @mcpanel/web -- test/cleanup-restore.test.tsx`

- [ ] **Step 5: 提交**

```bash
npm run typecheck && npm test && npm run lint
git add apps/web/src apps/web/test
git commit -m "feat(web): warn about restore leftovers and allow confirmed cleanup"
```

---

### Task 13: Playwright 冒烟

**Files:**
- Modify: `package.json`（devDependencies + `test:e2e` 脚本）
- Create: `playwright.config.ts`
- Create: `e2e/helpers.ts`
- Create: `e2e/global-setup.ts`
- Create: `e2e/smoke.spec.ts`
- Modify: `.gitignore`（`data-e2e/`、`e2e/.tmp/`、`test-results/` 已有则确认）

- [ ] **Step 1: 安装依赖与浏览器**

```bash
npm install -D @playwright/test
npx playwright install chromium
```

- [ ] **Step 2: 创建 e2e 辅助与全局初始化**

`e2e/helpers.ts`：

```ts
import path from 'node:path';

export const INSTANCE_ROOT = path.resolve('e2e/.tmp/instance');

export const ADMIN_PASSWORD = 'E2e-Password-2026';
```

`e2e/global-setup.ts`：

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { INSTANCE_ROOT } from './helpers';

export default async function globalSetup(): Promise<void> {
  await fs.rm(path.resolve('data-e2e'), { recursive: true, force: true });
  await fs.rm(path.resolve('e2e/.tmp'), { recursive: true, force: true });

  await fs.mkdir(path.join(INSTANCE_ROOT, 'world'), { recursive: true });
  await fs.mkdir(path.join(INSTANCE_ROOT, 'mods'), { recursive: true });
  await fs.writeFile(path.join(INSTANCE_ROOT, 'world', 'level.dat'), 'e2e-level');
  await fs.writeFile(path.join(INSTANCE_ROOT, 'mods', 'sample.jar'), 'jar');
  await fs.writeFile(path.join(INSTANCE_ROOT, 'eula.txt'), 'eula=true\n');
  await fs.writeFile(
    path.join(INSTANCE_ROOT, 'server.properties'),
    'level-name=world\nserver-port=25620\nenable-rcon=false\nonline-mode=true\nmotd=e2e\n',
  );
  const fixture = path.resolve('apps/server/test/fixtures/fake-server.mjs');
  await fs.writeFile(
    path.join(INSTANCE_ROOT, 'start.bat'),
    `@echo off\r\nnode "${fixture}" %*\r\n`,
  );
}
```

- [ ] **Step 3: 配置 Playwright**

`playwright.config.ts`：

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:3130',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build && npm start',
    url: 'http://127.0.0.1:3130/api/health',
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      NODE_ENV: 'production',
      PANEL_HOST: '127.0.0.1',
      PANEL_PORT: '3130',
      DATA_DIR: './data-e2e',
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
```

`package.json` scripts 增加：

```json
    "test:e2e": "playwright test"
```

`.gitignore` 确认包含 `data-e2e/` 与 `e2e/.tmp/`、`test-results/`、`playwright-report/`。

- [ ] **Step 4: 写冒烟用例**

`e2e/smoke.spec.ts`：

```ts
import { test, expect } from '@playwright/test';
import { ADMIN_PASSWORD, INSTANCE_ROOT } from './helpers';

test('init, onboard, run, back up and restore', async ({ page }) => {
  await page.goto('/setup');
  await page.getByLabel('密码', { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByLabel('确认密码').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: '创建管理员' }).click();
  await expect(page.getByRole('heading', { name: '总览' })).toBeVisible({ timeout: 20_000 });

  await page.goto('/instances');
  await page.getByRole('button', { name: '纳管实例' }).click();
  await page.getByLabel('服务器目录').fill(INSTANCE_ROOT);
  await page.getByRole('button', { name: '检测目录' }).click();
  await expect(page.getByText('start.bat')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: '创建实例' }).click();
  await expect(page.getByRole('heading', { name: 'survival' })).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: '启动' }).click();
  await expect(page.getByText('运行中').first()).toBeVisible({ timeout: 60_000 });

  await page.getByRole('link', { name: '控制台' }).click();
  await expect(page.getByText(/Starting minecraft server/)).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('服务器命令').fill('say hello e2e');
  await page.getByLabel('服务器命令').press('Enter');
  await expect(page.getByText(/received say hello e2e/)).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: '停止' }).click();
  await expect(page.getByText('已停止').first()).toBeVisible({ timeout: 60_000 });

  await page.getByRole('link', { name: '备份' }).click();
  await page.getByRole('button', { name: '立即备份' }).click();
  await expect(page.getByText('可用')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('备份完成')).toBeVisible({ timeout: 90_000 });

  await page.getByRole('button', { name: '恢复' }).click();
  await page.getByRole('button', { name: '确认恢复' }).click();
  await expect(page.getByText('恢复完成')).toBeVisible({ timeout: 90_000 });

  await page.reload();
  await expect(page.getByRole('heading', { name: 'survival' })).toBeVisible();

  await page.setViewportSize({ width: 375, height: 800 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
```

> `getByLabel('密码', { exact: true })` 依赖 `Field` 的 label 文本；若与“确认密码”歧义，改为按 `input[type=password]` 的 nth 选择。首次运行若 Playwright 浏览器缺失，按 Step 1 安装。

- [ ] **Step 5: 运行冒烟**

Run: `npm run test:e2e`
Expected: 1 个用例 PASS；产物 `test-results/` 已忽略。

- [ ] **Step 6: 提交**

```bash
git add package.json package-lock.json playwright.config.ts e2e .gitignore
git commit -m "test(e2e): add playwright smoke for full lifecycle"
```

---

### Task 14: 部署脚本、改密脚本与文档

**Files:**
- Create: `scripts/start-panel.bat`
- Create: `scripts/reset-password.mjs`
- Create: `docs/systemd.md`
- Modify: `README.md`
- Test: `apps/server/test/integration/reset-password.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resetPassword } from '../../../scripts/reset-password.mjs';
import { verifyPassword } from '../../src/auth/password';
import { openDatabase } from '../../src/db/client';
import { runMigrations, seedLocalNode } from '../../src/db/migrate';
import { users, sessions } from '../../src/db/schema';
import { insertUser } from '../helpers/factory';

let dir: string | undefined;

afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('reset-password script', () => {
  it('resets the hash and clears sessions', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-reset-'));
    const handle = openDatabase(path.join(dir, 'panel.db'));
    runMigrations(handle.sqlite, path.resolve('apps/server/drizzle'));
    seedLocalNode(handle.db);
    const id = insertUser(handle.db, 'admin', '$argon2id$placeholder');
    handle.db.insert(sessions).values({ id: 's1', userId: id, tokenHash: 'h', createdAt: Date.now(), expiresAt: Date.now() + 1000, ip: null, userAgent: null }).run();
    // 占位哈希不是合法 argon2，重置后应能用新密码验证
    await resetPassword(path.join(dir, 'panel.db'), 'admin', 'Brand-New-Password-2026');
    const row = handle.db.select().from(users).where(eq(users.username, 'admin')).get();
    expect(await verifyPassword(row!.passwordHash, 'Brand-New-Password-2026')).toBe(true);
    expect(handle.db.select().from(sessions).all()).toHaveLength(0);
    handle.sqlite.close();
  });
});
```

> 顶部补 `import { eq } from 'drizzle-orm';`。若 `insertUser` 的占位哈希导致 `verifyPassword` 抛错，改为先用 `hashPassword('old')` 写入。

- [ ] **Step 2: 实现改密脚本**

`scripts/reset-password.mjs`（ESM，可被 import；作为脚本时交互提示）：

```js
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export async function resetPassword(dbPath, username, password) {
  const { default: Database } = await import('better-sqlite3');
  const { hashPassword } = await import('../apps/server/src/auth/password.ts');
  const db = new Database(dbPath);
  try {
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (!user) throw new Error(`用户不存在：${username}`);
    const hash = await hashPassword(password);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, Date.now(), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  } finally {
    db.close();
  }
}

async function main() {
  const dataDir = path.resolve(repoRoot, process.env.DATA_DIR ?? 'data');
  const dbPath = path.join(dataDir, 'panel.db');
  if (!fs.existsSync(dbPath)) throw new Error(`找不到数据库：${dbPath}`);
  const username = process.argv[2] ?? 'admin';
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const password = await rl.question('新密码（至少 12 个字符）：');
    const confirm = await rl.question('再输入一次：');
    if (password.length < 12) throw new Error('密码至少 12 个字符');
    if (password !== confirm) throw new Error('两次输入的密码不一致');
    await resetPassword(dbPath, username, password);
    console.log(`已重置 ${username} 的密码，所有会话已失效。`);
  } finally {
    rl.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
```

> 脚本以 ESM + TS 源 import 运行在 Node 24 上不可行（不能 import `.ts`）。执行时改为：脚本内部直接使用 `argon2` 包计算哈希（`import argon2 from 'argon2'`，参数与 `apps/server/src/auth/password.ts` 保持一致 m=19456,t=2,p=1），避免依赖 TS 运行时。测试也直接调用该函数。

- [ ] **Step 3: Windows 一键启动**

`scripts/start-panel.bat`（CRLF）：

```bat
@echo off
setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，请先安装 Node.js 24 LTS 或更高版本。
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 24 (
  echo 当前 Node.js 主版本为 %NODE_MAJOR%，需要 24 或更高版本。
  pause
  exit /b 1
)

if not exist node_modules (
  echo 安装依赖...
  if exist package-lock.json ( call npm ci ) else ( call npm install )
  if errorlevel 1 ( pause & exit /b 1 )
)

if not exist apps\web\dist\index.html (
  echo 构建前端与后端...
  call npm run build
  if errorlevel 1 ( pause & exit /b 1 )
)

start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:3000"
call npm start
pause
```

> `.env` 若自定义了 `PANEL_PORT`/`PANEL_HOST`，打开浏览器的固定地址会不匹配；执行时可改为读取 `.env`（`for /f "tokens=1,2 delims==" %%a in (.env)`），或在 README 说明默认值。

- [ ] **Step 4: systemd 文档与 README**

`docs/systemd.md`：写入规格 §20.5 的 unit、用户创建、目录权限、反向代理提示、升级步骤。

`README.md`：
- 当前阶段补备份/计划/部署；
- 「开发」补 `npm run test:e2e`；
- 「生产」补 `scripts/start-panel.bat`；
- 新增「备份与恢复」「定时任务」「升级」小节（要点引用规格）。

- [ ] **Step 5: 运行测试**

Run: `npm test -w @mcpanel/server -- test/integration/reset-password.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
npm run typecheck && npm test && npm run lint
git add scripts docs/systemd.md README.md apps/server/test
git commit -m "feat: add deployment scripts, password reset and ops docs"
```

---

### Task 15: 阶段 3 验收、代码审查与收尾

**Files:**
- Modify: `README.md`、`docs/superpowers/plans/HANDOFF-phase3.md`（新建）
- Test: 全量命令 + 手工矩阵

- [ ] **Step 1: 全量自动化校验**

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm run test:e2e
```

Expected：全部通过；e2e 1 个用例 PASS。

- [ ] **Step 2: 手工验收（生产构建 + 真实/假服务端）**

逐项确认并记录结果：

- [ ] 运行中 + RCON 可用：备份成功，日志出现 `Saved the game`，备份结束后 `save-on` 已发送。
- [ ] 运行中 + RCON 不可用：备份被拒（409），提示停服后备份。
- [ ] `starting`/`stopping`/`unknown` 状态备份被拒。
- [ ] 停止状态冷备份 → 修改 world → 恢复 → 文件回到备份时内容，且多出 `pre_restore` 备份。
- [ ] 保留策略：`backupKeep=2` 时连续创建 4 个，旧备份被删，最新 `pre_restore` 保留。
- [ ] 计划任务：创建每分钟命令 → 触发成功并写运行记录；手动连续两次运行 → 第二次 `skipped`。
- [ ] 面板重启：`creating` 记录变 `failed`，`restoring` 记录变 `ready`，`.part` 被清理。
- [ ] 模拟恢复中断：手动构造 `.mcpanel-tmp/rollback-x/` 非空目录 → 概览出现警告 → 输入实例名清理成功。
- [ ] Windows：双击 `scripts/start-panel.bat` 能安装依赖、构建、启动并打开浏览器。
- [ ] 1280px 与 375px 下备份/计划页可用，无横向溢出（e2e 已覆盖 375px）。

- [ ] **Step 3: 代码审查**

用 `superpowers:requesting-code-review` 派发一次针对阶段 3 全部提交的审查（base = 阶段 2 收尾提交，head = 当前 HEAD），按严重级别修复 Critical/Important，记录其余为已知问题。

- [ ] **Step 4: 文档与交接**

新建 `docs/superpowers/plans/HANDOFF-phase3.md`，记录：提交表、手工验收结果、偏差（e2e 用冷备份、任务用 WS 频道、预览未来三次运行仅在服务端计算）、已知问题（面板自身数据备份需手工、计划运行无时区 DST 边界测试、备份进度为近似值）、以及阶段 4/后续建议（远程节点、告警、多用户）。

更新 `README.md` 的「当前阶段」为「第一版完成」。

- [ ] **Step 5: 最终提交**

```bash
git add README.md docs
git commit -m "docs: close out phase 3 with acceptance notes"
```

---

## 阶段 3 规格覆盖对照

| 规格章节 | 任务 |
| --- | --- |
| §12.1 备份范围与排除 | Task 2 |
| §12.2 严格一致性（save-off/flush/save-on、RCON 不可用拒绝） | Task 4、Task 5 |
| §12.3 创建流程（锁、磁盘检查、manifest、原子改名、进度） | Task 3、Task 5、Task 7 |
| §12.4 保留策略（含 pre_restore 保护） | Task 5 |
| §12.5 恢复流程（pre_restore、解压限制、rollback） | Task 6 |
| §12.6 中断恢复与清理动作 | Task 5、Task 7、Task 12（审查后补：启动时 rollback 残留 → `unknown`） |
| §13.1 计划动作 | Task 8 |
| §13.2 cron、时区、重叠跳过、不补跑 | Task 8、Task 9 |
| §13.3 运行记录（保留 100 条、手动触发） | Task 8、Task 11 |
| §16.8 备份 API | Task 7 |
| §16.9 计划 API | Task 9 |
| §17 任务频道 | Task 7 |
| §18.1 备份/计划路由 | Task 10、Task 11 |
| §20.4 Windows 一键启动 | Task 14 |
| §20.5 systemd | Task 14 |
| §20.6 升级与数据备份 | Task 14（README） |
| §21.3 Playwright 冒烟 | Task 13 |
| §22 阶段 3 验收 | Task 15 |

## 计划自审记录

- **依赖关系**：Task 2（源规划）→ 3（打包/解压）→ 4（冻结）→ 5（BackupService）→ 6（恢复）→ 7（路由/WS）→ 8/9（计划）→ 10–12（前端）→ 13（e2e）→ 14（部署）→ 15（验收）。后端任务之间有测试保护，前端任务只依赖已提交的接口。
- **有意偏差**：
  1. 任务进度走 `task:<id>` WS 频道而不是规格里的 “taskId + 轮询”；`TaskTracker` 内存保留 1 小时。
  2. Playwright 冒烟用**冷备份**（先停服再备份），避免 e2e 依赖假 RCON 的时序；运行中严格备份由 Task 4 的集成测试覆盖。
  3. 「未来 3 次运行」只在服务端计算（`nextRuns`），UI 不引入 cron 解析库，只展示下一次运行时间。
  4. 备份进度来自 `archiver` 的条目计数，是近似值；恢复进度按阶段百分比推进。
  5. `reset-password.mjs` 直接用 `argon2` 而不是 import TS 源码。
- **类型一致性**：`BackupInfo`、`BackupManifest`、`ScheduleInfo`、`ScheduleRunInfo`、`TaskInfo` 在 Task 1 定义；`TaskTracker.start/update/finish` 在 Task 5 定义并在 Task 6/8 复用；`startCreate` 返回 `{ task, backupId, done }` 在 Task 5 定义、Task 6/8/9 调用。
- **占位符扫描**：无 TBD/TODO；所有代码块均为完整实现。测试中的 `as never` 只用于最小依赖桩。
- **风险**：归档大世界时 `archiver` 的 `progress` 事件频率低，进度会跳跃；恢复的目录交换要求实例根与 `.mcpanel-tmp` 同卷（本来就是同一目录），无需额外处理跨卷。


