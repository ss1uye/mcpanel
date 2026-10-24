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
import { diskUsage } from '../utils/disk';
import { AppError } from '../utils/errors';
import { extractZipSafe } from '../utils/zip-extract';

export interface RestoreServiceDeps {
  db: DB;
  dataDir: string;
  backups: BackupService;
  tasks: TaskTracker;
  audit: AuditService;
  logger: Logger;
  stateOf?: (instanceId: string) => InstanceState;
}

export interface RestoreContext {
  backupId: string;
  file: string;
  manifest: BackupManifest;
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
        if (entry.fileName !== 'manifest.json') {
          fail(new AppError('ZIP_INVALID', '备份缺少 manifest.json'));
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError ?? new AppError('ZIP_INVALID', '无法读取 manifest'));
            return;
          }
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

export class RestoreService {
  constructor(private readonly deps: RestoreServiceDeps) {}

  async preflight(row: InstanceRow, backupId: string): Promise<RestoreContext> {
    const source = this.deps.db
      .select()
      .from(backups)
      .where(and(eq(backups.id, backupId), eq(backups.instanceId, row.id)))
      .get();
    if (!source) throw new AppError('NOT_FOUND', '备份不存在');
    if (source.status !== 'ready') throw new AppError('BACKUP_BUSY', '备份正在使用中');
    const state = this.deps.stateOf?.(row.id) ?? 'stopped';
    if (state !== 'stopped') throw new AppError('RESTORE_REQUIRES_STOP', '恢复前必须停止服务器');

    const file = path.join(this.deps.dataDir, 'backups', row.id, source.filename);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) throw new AppError('NOT_FOUND', '备份文件不存在');
    const manifest = await readManifest(file);
    const disk = await diskUsage(row.rootPath);
    if (disk.free < manifest.totalBytes * 1.2) {
      throw new AppError('INSUFFICIENT_DISK', '磁盘剩余空间不足（需要备份大小的 1.2 倍）');
    }
    return { backupId, file, manifest };
  }

  start(
    row: InstanceRow,
    context: RestoreContext,
    userId: string | null,
  ): { task: TaskInfo; done: Promise<void> } {
    const task = this.deps.tasks.start('restore', row.id);
    const done = this.deps.backups.withInstanceLock(row.id, () =>
      this.restoreInternal(row, context, userId, task),
    );
    return { task, done };
  }

  private async restoreInternal(
    row: InstanceRow,
    context: RestoreContext,
    userId: string | null,
    task: TaskInfo,
  ): Promise<void> {
    const db = this.deps.db;
    const { backupId, file, manifest } = context;
    const restoreDir = path.join(row.rootPath, '.mcpanel-tmp', `restore-${backupId}`);
    const rollbackDir = path.join(row.rootPath, '.mcpanel-tmp', `rollback-${backupId}`);

    db.update(backups).set({ status: 'restoring' }).where(eq(backups.id, backupId)).run();
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
