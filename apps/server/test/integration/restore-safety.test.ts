import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/logger';
import { PathSandbox } from '../../src/nodes/path-sandbox';
import { AuditService } from '../../src/services/audit-service';
import { BackupService } from '../../src/services/backup-service';
import { RestoreService } from '../../src/services/restore-service';
import { TaskTracker } from '../../src/services/task-tracker';
import { backups as backupsTable } from '../../src/db/schema';
import { createTestDb, type TestDb } from '../helpers/db';
import { insertInstanceRow } from '../helpers/factory';
import { makeZip } from '../helpers/zip';

let ctx: TestDb | undefined;
const dirs: string[] = [];

async function setup(
  stateRef: { state: 'stopped' | 'running' } = { state: 'stopped' },
  stateOfOverride?: () => 'stopped' | 'running',
) {
  ctx = createTestDb();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-restore-safety-'));
  dirs.push(dir);
  const root = path.join(dir, 'server');
  await fs.mkdir(path.join(root, 'world'), { recursive: true });
  await fs.writeFile(path.join(root, 'world', 'level.dat'), 'v1');
  await fs.writeFile(path.join(root, 'server.properties'), 'motd=v1\n');
  const instance = insertInstanceRow(ctx.db, { rootPath: root, backupIncludeConfig: true });
  const tasks = new TaskTracker();
  const audit = new AuditService(ctx.db);
  const sandbox = new PathSandbox(dir);
  const backups = new BackupService({
    db: ctx.db,
    dataDir: dir,
    instances: { list: () => [instance], get: () => instance } as never,
    supervisor: {
      getStatus: () => ({
        instanceId: instance.id,
        state: stateRef.state,
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
    sandbox,
  });
  const restore = new RestoreService({
    db: ctx.db,
    dataDir: dir,
    backups,
    tasks,
    audit,
    logger: silentLogger(),
    sandbox,
    stateOf: stateOfOverride ?? (() => stateRef.state),
  });
  return { dir, root, instance, backups, restore, stateRef };
}

async function insertCraftedBackup(
  dir: string,
  instanceId: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
): Promise<string> {
  const backupId = randomUUID();
  const filename = `${backupId}.zip`;
  await fs.mkdir(path.join(dir, 'backups', instanceId), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'backups', instanceId, filename),
    makeZip({ 'manifest.json': JSON.stringify({ schemaVersion: 1, ...manifest }), ...files }),
  );
  ctx!.db
    .insert(backupsTable)
    .values({
      id: backupId,
      instanceId,
      filename,
      kind: 'manual',
      status: 'ready',
      includesMods: false,
      createdAt: Date.now(),
      completedAt: Date.now(),
    })
    .run();
  return backupId;
}

afterEach(async () => {
  ctx?.close();
  ctx = undefined;
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('restore safety', () => {
  it('rejects a manifest with traversal or backslash sources', async () => {
    const { dir, instance, restore } = await setup();
    const traversal = await insertCraftedBackup(
      dir,
      instance.id,
      { totalBytes: 1, sources: ['../victim.txt'] },
      { 'victim.txt': 'x' },
    );
    await expect(restore.preflight(instance, traversal)).rejects.toMatchObject({ code: 'ZIP_INVALID' });

    const backslash = await insertCraftedBackup(
      dir,
      instance.id,
      { totalBytes: 1, sources: ['..\\victim.txt'] },
      { 'victim.txt': 'x' },
    );
    await expect(restore.preflight(instance, backslash)).rejects.toMatchObject({ code: 'ZIP_INVALID' });
  });

  it('rejects sources that resolve through a junction', async () => {
    const { dir, root, instance, restore } = await setup();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-outside-'));
    dirs.push(outside);
    await fs.writeFile(path.join(outside, 'file.txt'), 'outside');
    await fs.symlink(outside, path.join(root, 'plugins'), process.platform === 'win32' ? 'junction' : 'dir');
    const backupId = await insertCraftedBackup(
      dir,
      instance.id,
      { totalBytes: 5, sources: ['plugins'] },
      { 'plugins/file.txt': 'evil' },
    );
    await expect(restore.preflight(instance, backupId)).rejects.toMatchObject({ code: 'SYMLINK_NOT_ALLOWED' });
  });

  it('refuses restore when the instance is busy or a rollback directory exists', async () => {
    const stateRef = { state: 'stopped' as 'stopped' | 'running' };
    const { root, instance, backups, restore } = await setup(stateRef);
    const created = backups.startCreate(instance, 'manual');
    await created.done;

    stateRef.state = 'running';
    await expect(restore.preflight(instance, created.backupId)).rejects.toMatchObject({ code: 'RESTORE_REQUIRES_STOP' });

    stateRef.state = 'stopped';
    await fs.mkdir(path.join(root, '.mcpanel-tmp', 'rollback-old'), { recursive: true });
    await fs.writeFile(path.join(root, '.mcpanel-tmp', 'rollback-old', 'level.dat'), 'leftover');
    await expect(restore.preflight(instance, created.backupId)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('rolls back when the server starts mid-restore', async () => {
    const stateRef = { state: 'stopped' as 'stopped' | 'running' };
    let calls = 0;
    const { root, instance, backups, restore } = await setup(stateRef, () => (calls++ === 0 ? 'stopped' : 'running'));
    const created = backups.startCreate(instance, 'manual');
    await created.done;
    await fs.writeFile(path.join(root, 'world', 'level.dat'), 'v2');

    const context = await restore.preflight(instance, created.backupId);
    const task = restore.start(instance, context, null);
    await expect(task.done).rejects.toThrow(/回滚|启动/);
    expect(await fs.readFile(path.join(root, 'world', 'level.dat'), 'utf8')).toBe('v2');
  });

  it('recreates empty directories that were part of the backup', async () => {
    const { root, instance, backups, restore } = await setup();
    await fs.mkdir(path.join(root, 'config'), { recursive: true });
    const created = backups.startCreate(instance, 'manual');
    await created.done;
    await fs.rm(path.join(root, 'config'), { recursive: true, force: true });

    const context = await restore.preflight(instance, created.backupId);
    const task = restore.start(instance, context, null);
    await task.done;
    expect((await fs.stat(path.join(root, 'config'))).isDirectory()).toBe(true);
  });
});
