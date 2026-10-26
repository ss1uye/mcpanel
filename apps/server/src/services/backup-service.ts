import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PANEL_VERSION, type BackupInfo, type BackupKind, type BackupManifest, type TaskInfo } from '@mcpanel/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { DB } from '../db/client';
import { backups, type InstanceRow } from '../db/schema';
import type { PathSandbox } from '../nodes/path-sandbox';
import { diskUsage } from '../utils/disk';
import { AppError } from '../utils/errors';
import { writeBackupArchive } from './backup-archive';
import { withFrozenServer } from './backup-consistency';
import { planBackupSources } from './backup-sources';
import type { InstanceService } from './instance-service';
import type { InstanceSupervisor } from './instance-supervisor';
import { loadServerProperties, propertyValue } from './properties-service';
import type { RconService } from './rcon-service';
import type { TaskTracker } from './task-tracker';
import { stamp } from '../utils/stamp';

export interface BackupServiceDeps {
  db: DB;
  dataDir: string;
  instances: InstanceService;
  supervisor: InstanceSupervisor;
  rcon: RconService;
  tasks: TaskTracker;
  logger: Logger;
  sandbox: PathSandbox;
}

const LEVEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
  private readonly pending = new Set<string>();
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
    if (cached && cached.instanceId === instanceId) return cached;
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

  downloadable(instanceId: string, backupId: string): { path: string; filename: string } {
    const row = this.deps.db
      .select()
      .from(backups)
      .where(and(eq(backups.id, backupId), eq(backups.instanceId, instanceId)))
      .get();
    if (!row) throw new AppError('NOT_FOUND', '备份不存在');
    if (row.status !== 'ready') throw new AppError('INVALID_STATE', '备份尚不可下载');
    const file = path.join(this.deps.dataDir, 'backups', instanceId, row.filename);
    try {
      statSync(file);
    } catch {
      throw new AppError('NOT_FOUND', '备份文件不存在');
    }
    return { path: file, filename: row.filename };
  }

  /** Synchronous gate the routes can turn into 409 before a task is created. */
  assertIdle(instanceId: string): void {
    if (this.pending.has(instanceId) || this.deps.supervisor.isBusy(instanceId)) {
      throw new AppError('BACKUP_BUSY', '已有备份、恢复或其他实例操作在进行');
    }
  }

  /** Fast checks the route can surface as 409 before returning 202. */
  async preflight(row: InstanceRow): Promise<void> {
    this.assertIdle(row.id);
    const state = this.deps.supervisor.getStatus(row.id).state;
    if (state === 'starting' || state === 'stopping' || state === 'unknown') {
      throw new AppError('INVALID_STATE', `当前状态 ${state} 不能备份`);
    }
    if (state === 'running' || state === 'orphaned') {
      const rconStatus = await this.deps.rcon.statusFor(row);
      if (rconStatus !== 'connected') {
        throw new AppError('BACKUP_REQUIRES_STOP_OR_RCON', '服务器运行中且 RCON 不可用，请先停服再备份');
      }
    }
  }

  startCreate(
    row: InstanceRow,
    kind: BackupKind,
  ): { task: TaskInfo; backupId: string; done: Promise<void> } {
    this.assertIdle(row.id);
    this.pending.add(row.id);
    const task = this.deps.tasks.start('backup', row.id);
    const backupId = randomUUID();
    const done = this.deps.supervisor
      .runExclusive(row.id, () => this.createInternal(row, kind, backupId, task))
      .finally(() => {
        this.pending.delete(row.id);
      });
    return { task, backupId, done };
  }

  runExclusive<T>(instanceId: string, task: () => Promise<T>): Promise<T> {
    return this.deps.supervisor.runExclusive(instanceId, task);
  }

  /** Callers must already hold the instance lock (used by restore for pre_restore). */
  async createPreRestore(row: InstanceRow, task: TaskInfo, progressSpan: [number, number]): Promise<string> {
    const backupId = randomUUID();
    await this.createInternal(row, 'pre_restore', backupId, task, progressSpan, false);
    return backupId;
  }

  async remove(row: InstanceRow, backupId: string): Promise<void> {
    const backup = this.deps.db
      .select()
      .from(backups)
      .where(and(eq(backups.id, backupId), eq(backups.instanceId, row.id)))
      .get();
    if (!backup) throw new AppError('NOT_FOUND', '备份不存在');
    if (backup.status === 'creating' || backup.status === 'restoring') {
      throw new AppError('BACKUP_BUSY', '备份正在使用中');
    }
    await fs.rm(path.join(this.deps.dataDir, 'backups', row.id, backup.filename), { force: true });
    this.deps.db.delete(backups).where(eq(backups.id, backupId)).run();
    this.manifests.delete(backupId);
  }

  /** Returns instances that need an `unknown` override because a rollback directory is non-empty. */
  async recoverOnBoot(): Promise<Map<string, string>> {
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
    for (const entry of await fs.readdir(tmpDir).catch(() => [] as string[])) {
      if (!entry.endsWith('.part')) continue;
      const file = path.join(tmpDir, entry);
      const stat = await fs.stat(file).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 24 * 3600 * 1000) await fs.rm(file, { force: true });
    }

    const leftovers = new Map<string, string>();
    for (const instance of this.deps.instances.list()) {
      const base = path.join(instance.rootPath, '.mcpanel-tmp');
      const entries = await fs.readdir(base).catch(() => [] as string[]);
      const nonEmptyRollbacks: string[] = [];
      for (const entry of entries) {
        if (!entry.startsWith('rollback-')) continue;
        const files = await fs.readdir(path.join(base, entry)).catch(() => [] as string[]);
        if (files.length > 0) nonEmptyRollbacks.push(path.join(base, entry));
      }
      if (nonEmptyRollbacks.length > 0) {
        leftovers.set(instance.id, `恢复未完成，回滚目录保留在：${nonEmptyRollbacks.join('、')}`);
        continue;
      }
      for (const entry of entries) {
        if (entry.startsWith('restore-') || entry.startsWith('rollback-')) {
          await fs.rm(path.join(base, entry), { recursive: true, force: true }).catch(() => undefined);
        }
      }
    }

    for (const instance of this.deps.instances.list()) {
      const status = this.deps.supervisor.getStatus(instance.id);
      if (status.state !== 'running' && status.state !== 'orphaned') continue;
      const rconStatus = await this.deps.rcon.statusFor(instance);
      if (rconStatus === 'connected') {
        await this.deps.rcon.send(instance, 'save-on').catch((error: unknown) => {
          this.deps.logger.warn({ err: error, instanceId: instance.id }, 'save-on after boot recovery failed');
        });
      }
    }
    return leftovers;
  }

  private async validateSources(row: InstanceRow): Promise<{ levelName: string; extraPaths: string[] }> {
    const loaded = await loadServerProperties(row.rootPath).catch(() => null);
    const levelName = propertyValue(loaded?.parsed ?? null, 'level-name', 'world') || 'world';
    if (!LEVEL_NAME_PATTERN.test(levelName)) {
      throw new AppError('INVALID_STATE', 'server.properties 的 level-name 含有非法字符，无法安全备份');
    }
    let extraPaths: string[];
    try {
      const parsed = JSON.parse(row.backupExtraPaths) as unknown;
      extraPaths = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      extraPaths = [];
    }
    for (const extra of extraPaths) {
      // Sandbox resolution rejects `..`, drive letters and symlinked/junctioned parents.
      await this.deps.sandbox.resolve(row.rootPath, extra);
    }
    return { levelName, extraPaths };
  }

  private async createInternal(
    row: InstanceRow,
    kind: BackupKind,
    backupId: string,
    task: TaskInfo,
    progressSpan: [number, number] = [0, 1],
    finishTask = true,
  ): Promise<void> {
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
      const { levelName, extraPaths } = await this.validateSources(row);
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

      const pack = async (): Promise<{ bytes: number; manifest: BackupManifest }> => {
        // Plan and archive in the same pass. For a running server this runs
        // after save-off/save-all, so the file list reflects the frozen world.
        const plan = await planBackupSources(row.rootPath, {
          levelName,
          includeMods: row.backupIncludeMods,
          includeConfig: row.backupIncludeConfig,
          extraPaths,
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
        const bytes = await writeBackupArchive({
          root: row.rootPath,
          sources: plan.sources,
          destination: tmpFile,
          manifest,
          entries: { files: plan.files, directories: plan.directories },
          onProgress: (fraction) =>
            tasks.update(task.id, {
              progress: progressSpan[0] + fraction * (progressSpan[1] - progressSpan[0]),
            }),
        });
        await fs.mkdir(instanceDir, { recursive: true });
        await fs.rename(tmpFile, path.join(instanceDir, filename));
        return { bytes, manifest };
      };
      const { bytes, manifest } = running
        ? await withFrozenServer(
            {
              rcon: this.deps.rcon,
              instance: row,
              logFile: path.join(row.rootPath, 'logs', 'latest.log'),
              logger: this.deps.logger,
            },
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
      try {
        await this.enforceRetention(row);
      } catch (error) {
        this.deps.logger.warn({ err: error, instanceId: row.id }, 'backup retention failed');
      }
      if (finishTask) tasks.finish(task.id, 'success', '备份完成');
    } catch (error) {
      const message = error instanceof AppError ? error.message : '备份失败';
      this.deps.db
        .update(backups)
        .set({ status: 'failed', error: message, completedAt: Date.now() })
        .where(eq(backups.id, backupId))
        .run();
      await fs.rm(tmpFile, { force: true });
      if (finishTask) tasks.finish(task.id, 'failed', message);
      this.deps.logger.error({ err: error, instanceId: row.id }, 'backup failed');
      throw error;
    }
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
