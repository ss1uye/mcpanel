import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PANEL_VERSION, type BackupInfo, type BackupKind, type BackupManifest, type TaskInfo } from '@mcpanel/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { DB } from '../db/client';
import { backups, type InstanceRow } from '../db/schema';
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

export interface BackupServiceDeps {
  db: DB;
  dataDir: string;
  instances: InstanceService;
  supervisor: InstanceSupervisor;
  rcon: RconService;
  tasks: TaskTracker;
  logger: Logger;
}

function stamp(date: Date): string {
  const compact = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${compact.slice(0, 8)}-${compact.slice(8)}`;
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

  startCreate(
    row: InstanceRow,
    kind: BackupKind,
  ): { task: TaskInfo; backupId: string; done: Promise<void> } {
    const task = this.deps.tasks.start('backup', row.id);
    const backupId = randomUUID();
    const done = this.withInstanceLock(row.id, () => this.createInternal(row, kind, backupId, task));
    return { task, backupId, done };
  }

  /** Callers must already hold the instance lock (used by restore for pre_restore). */
  async createPreRestore(row: InstanceRow, task: TaskInfo, progressSpan: [number, number]): Promise<string> {
    const backupId = randomUUID();
    await this.createInternal(row, 'pre_restore', backupId, task, progressSpan);
    return backupId;
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
    for (const entry of await fs.readdir(tmpDir).catch(() => [] as string[])) {
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

  private async createInternal(
    row: InstanceRow,
    kind: BackupKind,
    backupId: string,
    task: TaskInfo,
    progressSpan: [number, number] = [0, 1],
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
      const loaded = await loadServerProperties(row.rootPath).catch(() => null);
      const levelName = propertyValue(loaded?.parsed ?? null, 'level-name', 'world') || 'world';
      const plan = await planBackupSources(row.rootPath, {
        levelName,
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
          onProgress: (fraction) =>
            tasks.update(task.id, {
              progress: progressSpan[0] + fraction * (progressSpan[1] - progressSpan[0]),
            }),
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
