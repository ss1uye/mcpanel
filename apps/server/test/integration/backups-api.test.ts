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
    runExclusive: async (_id: string, task: () => Promise<unknown>) => task(),
    isBusy: () => false,
  } as unknown as InstanceSupervisor;
  const instances = new InstanceService(ctx.db, dataDir);
  const tasks = new TaskTracker();
  const audit = new AuditService(ctx.db);
  const rcon = new RconService();
  const backups = new BackupService({
    db: ctx.db,
    dataDir,
    instances,
    supervisor,
    rcon,
    tasks,
    logger: silentLogger(),
    sandbox,
  });
  const restore = new RestoreService({ db: ctx.db, dataDir, backups, tasks, audit, logger: silentLogger(), sandbox });
  const app = await buildApp(
    config,
    ctx.db,
    {
      sessions,
      audit,
      loginThrottle: new LoginThrottle(),
      instances,
      supervisor,
      rcon,
      driver: new LocalNodeDriver(sandbox),
      probe: new ProbeService(sandbox, async () => null),
      files: new FileService(sandbox),
      sandbox,
      backups,
      restore,
      tasks,
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

async function waitReady(
  app: Awaited<ReturnType<typeof makeApp>>['app'],
  instanceId: string,
  headers: Record<string, string>,
) {
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
    expect(json<{ taskId: string }>(created).taskId).toBeTruthy();

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
