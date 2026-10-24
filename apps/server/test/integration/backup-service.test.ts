import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/logger';
import { BackupService } from '../../src/services/backup-service';
import { TaskTracker } from '../../src/services/task-tracker';
import { createTestDb, type TestDb } from '../helpers/db';
import { insertInstanceRow } from '../helpers/factory';

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
    supervisor: {
      getStatus: () => ({
        instanceId: instance.id,
        state: 'stopped',
        pid: null,
        startedAt: null,
        exitCode: null,
        error: null,
      }),
    } as never,
    rcon: { statusFor: async () => 'disabled', send: async () => '' } as never,
    tasks: new TaskTracker(),
    logger: silentLogger(),
  });
  return { service, instance, dir };
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
    await service.startCreate(instance, 'pre_restore').done;
    await service.startCreate(instance, 'manual').done;
    await service.startCreate(instance, 'manual').done;
    const backups = service.list(instance.id);
    expect(backups.some((backup) => backup.kind === 'pre_restore')).toBe(true);
    expect(backups).toHaveLength(2);
  });

  it('marks interrupted records on boot and deletes stale part files', async () => {
    const { service, instance, dir } = await setup();
    ctx!.sqlite
      .prepare(
        `INSERT INTO backups (id, instance_id, filename, kind, status, includes_mods, created_at) VALUES (?, ?, ?, 'manual', 'creating', 0, ?)`,
      )
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
