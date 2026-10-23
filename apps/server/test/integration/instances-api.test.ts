import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app';
import { SessionService } from '../../src/auth/session';
import { LoginThrottle } from '../../src/auth/guard';
import { loadConfig } from '../../src/config';
import { silentLogger } from '../../src/logger';
import { LocalNodeDriver } from '../../src/nodes/local-driver';
import { PathSandbox } from '../../src/nodes/path-sandbox';
import { AuditService } from '../../src/services/audit-service';
import { InstanceService } from '../../src/services/instance-service';
import { insertUser } from '../helpers/factory';
import { ProbeService } from '../../src/services/probe-service';
import { RconService } from '../../src/services/rcon-service';
import type { InstanceSupervisor } from '../../src/services/instance-supervisor';
import { createTestDb, type TestDb } from '../helpers/db';
import { CookieJar, TEST_ORIGIN, json } from '../helpers/http';

let ctx: TestDb | undefined;
const roots: string[] = [];

async function makeApp() {
  ctx = createTestDb();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-api-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'eula.txt'), 'eula=true\n');
  await fs.writeFile(path.join(root, 'run.bat'), '@echo off\r\n');

  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: ctx.dir });
  const sessions = new SessionService(ctx.db);
  const { token } = sessions.create(insertUser(ctx.db), null, null);
  const supervisor = Object.assign(new EventEmitter(), {
    getStatus: (instanceId: string) => ({
      instanceId,
      state: 'stopped',
      pid: null,
      startedAt: null,
      exitCode: null,
      error: null,
    }),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    kill: vi.fn(async () => undefined),
    markStopped: vi.fn(async () => undefined),
    sendCommand: vi.fn(async () => undefined),
    getRecentLines: vi.fn(async () => [
      { seq: 1, ts: new Date().toISOString(), stream: 'stdout', level: 'info', text: 'hello' },
    ]),
    getLogFilePath: (instanceId: string) => path.join(root, 'logs', `${instanceId}.log`),
  }) as unknown as InstanceSupervisor;

  const sandbox = new PathSandbox(ctx.dir);
  const services = {
    sessions,
    audit: new AuditService(ctx.db),
    loginThrottle: new LoginThrottle(),
    supervisor,
    rcon: new RconService(),
    driver: new LocalNodeDriver(sandbox),
    probe: new ProbeService(sandbox, async () => ({ path: 'java', major: 21 })),
    instances: new InstanceService(ctx.db, ctx.dir),
  };
  const app = await buildApp(config, ctx.db, services, { logger: silentLogger() });

  const jar = new CookieJar();
  const csrf = await app.inject({ method: 'GET', url: '/api/auth/csrf', headers: { cookie: `mcpanel_session=${token}` } });
  jar.absorb(csrf);
  jar.set('mcpanel_session', token);
  return {
    app,
    root,
    supervisor,
    headers: { origin: TEST_ORIGIN, cookie: jar.header(), 'x-csrf-token': json<{ token: string }>(csrf).token },
    readHeaders: { cookie: jar.header() },
  };
}

afterEach(async () => {
  ctx?.close();
  ctx = undefined;
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('instances API', () => {
  it('probes, creates, lists, updates, runs actions, deletes and audits', async () => {
    const { app, root, supervisor, headers, readHeaders } = await makeApp();

    const probe = await app.inject({ method: 'POST', url: '/api/instances/probe', headers, payload: { rootPath: root } });
    expect(probe.statusCode).toBe(200);
    const probed = json<{ suggestedStartCommand: string; detected: { eula: boolean } }>(probe);
    expect(probed.suggestedStartCommand).toBe('run.bat');
    expect(probed.detected.eula).toBe(true);

    const created = await app.inject({
      method: 'POST',
      url: '/api/instances',
      headers,
      payload: { name: '生存服', rootPath: root, startCommand: 'run.bat' },
    });
    expect(created.statusCode).toBe(201);
    const instance = json<{ id: string; name: string; state: string; rootPath: string }>(created);
    expect(instance.rootPath).toBe(await fs.realpath(root));

    const list = await app.inject({ method: 'GET', url: '/api/instances', headers: readHeaders });
    expect(json<{ items: unknown[] }>(list).items).toHaveLength(1);

    const detail = await app.inject({ method: 'GET', url: `/api/instances/${instance.id}`, headers: readHeaders });
    expect(json<{ backupExtraPaths: string[]; rconStatus: string }>(detail)).toMatchObject({
      backupExtraPaths: [],
      rconStatus: 'unreachable',
    });

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/instances/${instance.id}`,
      headers,
      payload: { name: '生存服 2', stopTimeoutSec: 45, backupExtraPaths: ['plugins'] },
    });
    expect(patched.statusCode).toBe(200);
    expect(json<{ name: string; stopTimeoutSec: number; backupExtraPaths: string[] }>(patched)).toMatchObject({
      name: '生存服 2',
      stopTimeoutSec: 45,
      backupExtraPaths: ['plugins'],
    });

    const emptyPatch = await app.inject({ method: 'PATCH', url: `/api/instances/${instance.id}`, headers, payload: {} });
    expect(emptyPatch.statusCode).toBe(400);

    const started = await app.inject({ method: 'POST', url: `/api/instances/${instance.id}/actions/start`, headers });
    expect(started.statusCode).toBe(202);
    expect(supervisor.start).toHaveBeenCalledWith(instance.id);

    const command = await app.inject({
      method: 'POST',
      url: `/api/instances/${instance.id}/console/command`,
      headers,
      payload: { command: 'say hi' },
    });
    expect(command.statusCode).toBe(200);
    expect(supervisor.sendCommand).toHaveBeenCalledWith(instance.id, 'say hi');

    const multiline = await app.inject({
      method: 'POST',
      url: `/api/instances/${instance.id}/console/command`,
      headers,
      payload: { command: 'say a\nsay b' },
    });
    expect(multiline.statusCode).toBe(400);

    const logs = await app.inject({ method: 'GET', url: `/api/instances/${instance.id}/logs`, headers: readHeaders });
    expect(json<{ lines: { text: string }[] }>(logs).lines[0]?.text).toBe('hello');

    const missingLog = await app.inject({
      method: 'GET',
      url: `/api/instances/${instance.id}/logs/download`,
      headers: readHeaders,
    });
    expect(missingLog.statusCode).toBe(404);

    const wrongConfirm = await app.inject({
      method: 'DELETE',
      url: `/api/instances/${instance.id}`,
      headers,
      payload: { confirmName: 'nope' },
    });
    expect(wrongConfirm.statusCode).toBe(400);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/instances/${instance.id}`,
      headers,
      payload: { confirmName: '生存服 2' },
    });
    expect(deleted.statusCode).toBe(204);
    expect(await fs.readdir(root)).toContain('run.bat');

    const audit = await app.inject({ method: 'GET', url: '/api/audit?page=1&pageSize=50', headers: readHeaders });
    const actions = json<{ items: { action: string }[]; total: number }>(audit).items.map((entry) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'instance.create',
        'instance.update',
        'console.command',
        'instance.delete',
      ]),
    );
  });

  it('rejects duplicate names, duplicate roots and unauthenticated access', async () => {
    const { app, root, headers, readHeaders } = await makeApp();
    const payload = { name: 'A', rootPath: root, startCommand: 'run.bat' };
    expect((await app.inject({ method: 'POST', url: '/api/instances', headers, payload })).statusCode).toBe(201);

    const duplicateRoot = await app.inject({
      method: 'POST',
      url: '/api/instances',
      headers,
      payload: { ...payload, name: 'B' },
    });
    expect(duplicateRoot.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(duplicateRoot).error.code).toBe('ROOT_OVERLAPS');

    const duplicateName = await app.inject({
      method: 'POST',
      url: '/api/instances',
      headers,
      payload: { ...payload, rootPath: await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-api-')) },
    });
    expect(duplicateName.statusCode).toBe(400);
    expect(json<{ error: { details: { field: string } } }>(duplicateName).error.details.field).toBe('name');

    const anonymous = await app.inject({ method: 'GET', url: '/api/instances' });
    expect(anonymous.statusCode).toBe(401);

    const noCsrf = await app.inject({ method: 'POST', url: '/api/instances', headers: readHeaders, payload });
    expect(noCsrf.statusCode).toBe(403);

    const missing = await app.inject({ method: 'GET', url: `/api/instances/${'0'.repeat(32).slice(0, 8)}-0000-4000-8000-000000000000`, headers: readHeaders });
    expect(missing.statusCode).toBe(404);
  });

  it('rejects a root that overlaps the panel data directory', async () => {
    const { app, headers } = await makeApp();
    const inside = path.join(ctx!.dir, 'server-inside-data');
    await fs.mkdir(inside, { recursive: true });
    const response = await app.inject({
      method: 'POST',
      url: '/api/instances/probe',
      headers,
      payload: { rootPath: inside },
    });
    expect(response.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(response).error.code).toBe('ROOT_OVERLAPS');
  });
});
