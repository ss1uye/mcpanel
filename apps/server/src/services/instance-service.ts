import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { createInstanceSchema, RootValidation, updateInstanceSchema } from '@mcpanel/shared';
import type { DB } from '../db/client';
import { instances, type InstanceRow } from '../db/schema';
import { AppError } from '../utils/errors';
import { toRootKey } from '../nodes/path-sandbox';

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
    const rootKey = toRootKey(root.realPath);
    if (this.db.select().from(instances).where(eq(instances.rootPathKey, rootKey)).get()) {
      throw new AppError('ROOT_OVERLAPS', '该目录已被其他实例纳管');
    }
    const now = Date.now();
    const row: InstanceRow = {
      id: crypto.randomUUID(),
      nodeId: 'local',
      name: input.name,
      rootPath: root.realPath,
      rootPathKey: rootKey,
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

  /** Returns the row that was removed so callers can audit it. */
  delete(row: InstanceRow, confirmName: string): InstanceRow {
    if (confirmName !== row.name) {
      throw new AppError('VALIDATION_ERROR', '确认名称与实例名称不一致', { field: 'confirmName' });
    }
    if (row.lastState !== 'stopped' && row.lastState !== 'crashed') {
      throw new AppError('INVALID_STATE', '请先停止服务器并确认进程已结束');
    }
    const leftovers = rollbackLeftovers(row.rootPath);
    if (leftovers.length > 0) {
      throw new AppError('INVALID_STATE', '实例存在未处理的恢复残留，请先清理');
    }
    fs.rmSync(path.join(this.dataDir, 'backups', row.id), { recursive: true, force: true });
    this.db.delete(instances).where(eq(instances.id, row.id)).run();
    return row;
  }

  private assertNameAvailable(name: string, excludeId?: string): void {
    const rows = this.db.select().from(instances).where(sql`lower(${instances.name}) = lower(${name})`).all();
    if (rows.some((row) => row.id !== excludeId)) {
      throw new AppError('VALIDATION_ERROR', '实例名称已存在', { field: 'name' });
    }
  }
}

export function rollbackLeftovers(rootPath: string): string[] {
  const tmpDir = path.join(rootPath, '.mcpanel-tmp');
  if (!fs.existsSync(tmpDir)) return [];
  return fs
    .readdirSync(tmpDir)
    .filter((name) => name.startsWith('rollback-') && hasEntries(path.join(tmpDir, name)));
}

function hasEntries(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}
