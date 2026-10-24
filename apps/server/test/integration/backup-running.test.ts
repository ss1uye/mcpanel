import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PathSandbox } from '../../src/nodes/path-sandbox';
import { silentLogger } from '../../src/logger';
import { BackupService } from '../../src/services/backup-service';
import { RconService } from '../../src/services/rcon-service';
import { TaskTracker } from '../../src/services/task-tracker';
import { createTestDb, type TestDb } from '../helpers/db';
import { insertInstanceRow } from '../helpers/factory';
import { startFakeRcon } from '../fixtures/fake-rcon.mjs';

let ctx: TestDb | undefined;
let dir: string;
const closers: Array<() => Promise<void>> = [];

async function setup() {
  ctx = createTestDb();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-backup-running-'));
  const root = path.join(dir, 'server');
  await fs.mkdir(path.join(root, 'world'), { recursive: true });
  await fs.mkdir(path.join(root, 'logs'), { recursive: true });
  await fs.writeFile(path.join(root, 'world', 'level.dat'), 'level');
  await fs.writeFile(path.join(root, 'logs', 'latest.log'), '[Server thread/INFO]: started\n');
  const logFile = path.join(root, 'logs', 'latest.log');
  const fake = await startFakeRcon({ password: 'secret', logFile, saveAllDelayMs: 10 });
  closers.push(fake.close);
  await fs.writeFile(
    path.join(root, 'server.properties'),
    `enable-rcon=true\nrcon.port=${fake.port}\nrcon.password=secret\n`,
  );
  const instance = insertInstanceRow(ctx.db, { rootPath: root, rconHost: '127.0.0.1' });
  const rcon = new RconService();
  const supervisor = {
    getStatus: () => ({
      instanceId: instance.id,
      state: 'running',
      pid: 4242,
      startedAt: new Date().toISOString(),
      exitCode: null,
      error: null,
    }),
    runExclusive: async (_id: string, task: () => Promise<unknown>) => task(),
    isBusy: () => false,
  } as never;
  const service = new BackupService({
    db: ctx.db,
    dataDir: dir,
    instances: { list: () => [instance], get: () => instance } as never,
    supervisor,
    rcon,
    tasks: new TaskTracker(),
    logger: silentLogger(),
    sandbox: new PathSandbox(dir),
  });
  return { service, instance, rcon, fake };
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  ctx?.close();
  ctx = undefined;
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe('BackupService while running', () => {
  it('freezes, flushes, packs and re-enables saving', async () => {
    const { service, instance, rcon, fake } = await setup();
    await rcon.test(instance);
    const { done } = service.startCreate(instance, 'manual');
    await done;
    expect(service.list(instance.id)[0]).toMatchObject({ status: 'ready' });
    expect(fake.commands).toEqual(expect.arrayContaining(['save-off', 'save-all flush', 'save-on']));
    const off = fake.commands.indexOf('save-off');
    const on = fake.commands.indexOf('save-on');
    expect(off).toBeGreaterThanOrEqual(0);
    expect(on).toBeGreaterThan(off);
  });

  it('refuses to back up while running without RCON', async () => {
    const { service, instance } = await setup();
    await expect(service.preflight(instance)).rejects.toMatchObject({
      code: 'BACKUP_REQUIRES_STOP_OR_RCON',
    });
    expect(service.list(instance.id)).toHaveLength(0);
  });
});
