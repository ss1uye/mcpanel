import fs from 'node:fs/promises';
import path from 'node:path';
import type { BackupManifest, InstanceState, TaskInfo } from '@mcpanel/shared';
import yauzl from 'yauzl';
import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { DB } from '../db/client';
import { backups, type InstanceRow } from '../db/schema';
import type { PathSandbox } from '../nodes/path-sandbox';
import { diskUsage } from '../utils/disk';
import { AppError } from '../utils/errors';
import { extractZipSafe } from '../utils/zip-extract';
import type { AuditService } from './audit-service';
import { clearServerPropertiesCache } from './properties-service';
import type { BackupService } from './backup-service';
import type { TaskTracker } from './task-tracker';

const MAX_MANIFEST_BYTES = 1024 * 1024;

export interface RestoreServiceDeps {
  db: DB;
  dataDir: string;
  backups: BackupService;
  tasks: TaskTracker;
  audit: AuditService;
  logger: Logger;
  sandbox: PathSandbox;
  stateOf?: (instanceId: string) => InstanceState;
}

export interface RestoreContext {
  backupId: string;
  file: string;
  manifest: BackupManifest;
}

export function validateManifest(manifest: BackupManifest): void {
  if (manifest.schemaVersion !== 1) throw new AppError('ZIP_INVALID', '不支持的备份格式版本');
  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0 || manifest.sources.length > 200) {
    throw new AppError('ZIP_INVALID', '备份清单中的源路径数量不合法');
  }
  for (const source of manifest.sources) {
    if (typeof source !== 'string' || source.length === 0 || source.length > 512) {
      throw new AppError('ZIP_INVALID', '备份清单包含非法路径');
    }
    if (
      source.includes('\\') ||
      source.includes('\0') ||
      source.startsWith('/') ||
      /^[A-Za-z]:/.test(source) ||
      source.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      throw new AppError('ZIP_INVALID', `备份清单包含越界路径：${source}`);
    }
    if (source.split('/')[0]!.toLowerCase() === '.mcpanel-tmp') {
      throw new AppError('ZIP_INVALID', '备份清单不能包含面板临时目录');
    }
  }
  if (!Number.isFinite(manifest.totalBytes) || manifest.totalBytes < 0) {
    throw new AppError('ZIP_INVALID', '备份清单的大小字段不合法');
  }
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
      zip.on('end', () => fail(new AppError('ZIP_INVALID', '备份缺少 manifest.json')));
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName !== 'manifest.json') {
          fail(new AppError('ZIP_INVALID', '备份缺少 manifest.json'));
          return;
        }
        if (entry.uncompressedSize > MAX_MANIFEST_BYTES) {
          fail(new AppError('ZIP_INVALID', '备份 manifest 过大'));
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError ?? new AppError('ZIP_INVALID', '无法读取 manifest'));
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          stream.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_MANIFEST_BYTES) {
              fail(new AppError('ZIP_INVALID', '备份 manifest 过大'));
              return;
            }
            chunks.push(chunk);
          });
          stream.on('error', fail);
          stream.on('end', () => {
            if (settled) return;
            settled = true;
            zip.close();
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as BackupManifest);
            } catch {
              reject(new AppError('ZIP_INVALID', '备份 manifest 格式错误'));
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
    this.deps.backups.assertIdle(row.id);
    const source = this.deps.db
      .select()
      .from(backups)
      .where(and(eq(backups.id, backupId), eq(backups.instanceId, row.id)))
      .get();
    if (!source) throw new AppError('NOT_FOUND', '备份不存在');
    if (source.status !== 'ready') throw new AppError('BACKUP_BUSY', '备份正在使用中');
    const state = this.deps.stateOf?.(row.id) ?? 'stopped';
    if (state !== 'stopped') throw new AppError('RESTORE_REQUIRES_STOP', '恢复前必须停止服务器');

    const leftovers = await rollbackLeftovers(row.rootPath);
    if (leftovers.length > 0) {
      throw new AppError('INVALID_STATE', `存在未清理的恢复残留（${leftovers[0]}），请先在概览页清理`);
    }

    const file = path.join(this.deps.dataDir, 'backups', row.id, source.filename);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) throw new AppError('NOT_FOUND', '备份文件不存在');
    const manifest = await readManifest(file);
    validateManifest(manifest);
    for (const sourceRel of manifest.sources) {
      // Resolve every source so a junction inside the instance cannot redirect the swap.
      await this.deps.sandbox.resolve(row.rootPath, sourceRel);
    }
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
    this.deps.backups.assertIdle(row.id);
    const task = this.deps.tasks.start('restore', row.id);
    const done = this.deps.backups.runExclusive(row.id, () =>
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
    const sandbox = this.deps.sandbox;
    const { backupId, file, manifest } = context;
    const restoreRel = `.mcpanel-tmp/restore-${backupId}`;
    const rollbackRel = `.mcpanel-tmp/rollback-${backupId}`;
    const restoreDir = await sandbox.resolve(row.rootPath, restoreRel);
    const rollbackDir = await sandbox.resolve(row.rootPath, rollbackRel);

    db.update(backups).set({ status: 'restoring' }).where(eq(backups.id, backupId)).run();
    try {
      await this.deps.backups.createPreRestore(row, task, [0, 0.2]);

      await fs.rm(restoreDir, { recursive: true, force: true });
      await extractZipSafe(file, restoreDir, {
        maxEntries: 1_000_000,
        maxBytes: Math.max(manifest.totalBytes * 1.1, 2 * 1024 * 1024 * 1024),
      });
      for (const sourceRel of manifest.sources) {
        const stat = await fs
          .lstat(await sandbox.resolve(row.rootPath, `${restoreRel}/${sourceRel}`))
          .catch(() => null);
        if (!stat) throw new AppError('ZIP_INVALID', `备份缺少内容：${sourceRel}`);
      }
      this.deps.tasks.update(task.id, { progress: 0.6 });

      const moved: Array<{ source: string; rollback: string; target: string }> = [];
      const created: string[] = [];
      await fs.mkdir(rollbackDir, { recursive: true });
      try {
        for (const sourceRel of manifest.sources) {
          const target = await sandbox.resolve(row.rootPath, sourceRel);
          const rollback = await sandbox.resolve(row.rootPath, `${rollbackRel}/${sourceRel}`);
          const exists = await fs.lstat(target).then(
            () => true,
            () => false,
          );
          if (!exists) continue;
          await fs.mkdir(path.dirname(rollback), { recursive: true });
          await fs.rename(target, rollback);
          moved.push({ source: sourceRel, rollback, target });
        }
        this.deps.tasks.update(task.id, { progress: 0.75 });

        const state = this.deps.stateOf?.(row.id) ?? 'stopped';
        if (state !== 'stopped') {
          throw new AppError('INVALID_STATE', '服务器在恢复过程中被启动，已中止并回滚');
        }

        for (const sourceRel of manifest.sources) {
          const from = await sandbox.resolve(row.rootPath, `${restoreRel}/${sourceRel}`);
          const to = await sandbox.resolve(row.rootPath, sourceRel);
          await fs.mkdir(path.dirname(to), { recursive: true });
          await fs.rename(from, to);
          created.push(to);
        }
      } catch (error) {
        for (const target of [...created].reverse()) {
          await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
        }
        const failedBack: string[] = [];
        for (const item of [...moved].reverse()) {
          try {
            await fs.mkdir(path.dirname(item.target), { recursive: true });
            await fs.rename(item.rollback, item.target);
          } catch {
            failedBack.push(item.source);
          }
        }
        const detail =
          failedBack.length > 0 ? `；以下路径未能回滚：${failedBack.join('、')}，保留在 ${rollbackDir}` : '';
        const message = error instanceof AppError ? `${error.message}${detail}` : `恢复失败${detail}`;
        throw new AppError('INTERNAL', message);
      }

      await fs.rm(restoreDir, { recursive: true, force: true }).catch((error: unknown) => {
        this.deps.logger.warn({ err: error, instanceId: row.id }, 'restore staging cleanup failed');
      });
      await fs.rm(rollbackDir, { recursive: true, force: true }).catch((error: unknown) => {
        this.deps.logger.warn({ err: error, instanceId: row.id }, 'restore rollback cleanup failed');
      });
      clearServerPropertiesCache();
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
      clearServerPropertiesCache();
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
