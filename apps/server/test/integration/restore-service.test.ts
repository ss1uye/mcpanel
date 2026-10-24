import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PathSandbox } from '../../src/nodes/path-sandbox';
import { silentLogger } from '../../src/logger';
import { AuditService } from '../../src/services/audit-service';
import { BackupService } from '../../src/services/backup-service';
import { RestoreService } from '../../src/services/restore-service';
import { TaskTracker } from '../../src/services/task-tracker';
import { createTestDb, type TestDb } from '../helpers/db';
import { insertInstanceRow } from '../helpers/factory';

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
  const tasks = new TaskTracker();
  const audit = new AuditService(ctx.db);
  const backups = new BackupService({
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
      runExclusive: async (_id: string, task: () => Promise<unknown>) => task(),
      isBusy: () => false,
    } as never,
    rcon: { statusFor: async () => 'disabled', send: async () => '' } as never,
    tasks,
    logger: silentLogger(),
    sandbox: new PathSandbox(dir),
  });
  const restore = new RestoreService({
    db: ctx.db,
    dataDir: dir,
    backups,
    tasks,
    audit,
    logger: silentLogger(),
    sandbox: new PathSandbox(dir),
  });
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

    const context = await restore.preflight(instance, created.backupId);
    const task = restore.start(instance, context, null);
    await task.done;

    expect(await fs.readFile(path.join(root, 'world', 'level.dat'), 'utf8')).toBe('v1');
    expect(await fs.readFile(path.join(root, 'server.properties'), 'utf8')).toBe('motd=v1\n');
    expect(
      backups.list(instance.id).some((backup) => backup.kind === 'pre_restore' && backup.status === 'ready'),
    ).toBe(true);
    await expect(
      fs.stat(path.join(root, '.mcpanel-tmp', `restore-${created.backupId}`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires the instance to be stopped', async () => {
    const { dir, instance, backups } = await setup();
    const created = backups.startCreate(instance, 'manual');
    await created.done;
    const running = new RestoreService({
      db: ctx!.db,
      dataDir: dir,
      backups,
      tasks: new TaskTracker(),
      audit: new AuditService(ctx!.db),
      logger: silentLogger(),
      sandbox: new PathSandbox(dir),
      stateOf: () => 'running',
    });
    await expect(running.preflight(instance, created.backupId)).rejects.toMatchObject({
      code: 'RESTORE_REQUIRES_STOP',
    });
  });

  it('refuses unknown backups', async () => {
    const { instance, restore } = await setup();
    await expect(restore.preflight(instance, 'missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
