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
import { FileService } from '../../src/services/file-service';
import { InstanceService } from '../../src/services/instance-service';
import { ProbeService } from '../../src/services/probe-service';
import { RconService } from '../../src/services/rcon-service';
import type { InstanceSupervisor } from '../../src/services/instance-supervisor';
import { insertInstance, insertUser } from '../helpers/factory';
import { createTestDb, type TestDb } from '../helpers/db';
import { CookieJar, TEST_ORIGIN, json } from '../helpers/http';

let ctx: TestDb | undefined;
const roots: string[] = [];

const PROPS =
  '# Minecraft server properties\r\nmotd=Old\r\nserver-port=25565\r\nmotd=Duplicate\r\n\r\nview-distance=10\r\n';

async function makeApp() {
  ctx = createTestDb();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-config-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'server.properties'), PROPS);
  await fs.writeFile(
    path.join(root, 'eula.txt'),
    '#By changing the setting below to TRUE you are indicating your agreement\n_eula=false\n',
  );

  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: ctx.dir });
  const sessions = new SessionService(ctx.db);
  const { token } = sessions.create(insertUser(ctx.db), null, null);
  const instanceId = insertInstance(ctx.db, { rootPath: root });
  const sandbox = new PathSandbox(ctx.dir);
  const supervisor = {
    getStatus: () => ({
      instanceId,
      state: 'stopped',
      pid: null,
      startedAt: null,
      exitCode: null,
      error: null,
    }),
  } as unknown as InstanceSupervisor;
  const app = await buildApp(
    config,
    ctx.db,
    {
      sessions,
      audit: new AuditService(ctx.db),
      loginThrottle: new LoginThrottle(),
      instances: new InstanceService(ctx.db, ctx.dir),
      supervisor,
      rcon: new RconService(),
      driver: new LocalNodeDriver(sandbox),
      probe: new ProbeService(sandbox, async () => null),
      files: new FileService(sandbox),
      sandbox,
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

afterEach(async () => {
  ctx?.close();
  ctx = undefined;
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('config API', () => {
  it('reports entries, duplicates, the original EOL and the EULA flag', async () => {
    const { app, instanceId, readHeaders } = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/instances/${instanceId}/config/properties`,
      headers: readHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = json<{
      duplicates: string[];
      eol: string;
      raw: string;
      eula: boolean;
      entries: Array<{ key: string; value: string }>;
    }>(res);
    expect(body.duplicates).toEqual(['motd']);
    expect(body.eol).toBe('\r\n');
    expect(body.eula).toBe(false);
    expect(body.entries.filter((entry) => entry.key === 'motd').map((entry) => entry.value)).toEqual(['Old', 'Duplicate']);
  });

  it('patches every duplicate, keeps comments and order, and guards mtime', async () => {
    const { app, root, instanceId, headers, readHeaders } = await makeApp();
    const before = json<{ mtime: number }>(
      await app.inject({ method: 'GET', url: `/api/instances/${instanceId}/config/properties`, headers: readHeaders }),
    );
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/instances/${instanceId}/config/properties`,
      headers,
      payload: { changes: { motd: '新公告', 'max-players': '20' }, expectedMtime: before.mtime },
    });
    expect(saved.statusCode).toBe(200);

    const raw = await fs.readFile(path.join(root, 'server.properties'), 'utf8');
    expect(raw.startsWith('# Minecraft server properties\r\n')).toBe(true);
    expect(raw).toContain('motd=新公告\r\nserver-port=25565\r\nmotd=新公告\r\n');
    expect(raw.endsWith('max-players=20\r\n')).toBe(true);

    const conflict = await app.inject({
      method: 'PUT',
      url: `/api/instances/${instanceId}/config/properties`,
      headers,
      payload: { changes: { motd: 'x' }, expectedMtime: before.mtime },
    });
    expect(conflict.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(conflict).error.code).toBe('MTIME_CONFLICT');
  });

  it('rejects invalid values before touching the file', async () => {
    const { app, root, instanceId, headers, readHeaders } = await makeApp();
    const before = json<{ mtime: number }>(
      await app.inject({ method: 'GET', url: `/api/instances/${instanceId}/config/properties`, headers: readHeaders }),
    );
    const res = await app.inject({
      method: 'PUT',
      url: `/api/instances/${instanceId}/config/properties`,
      headers,
      payload: { changes: { 'server-port': '70000' }, expectedMtime: before.mtime },
    });
    expect(res.statusCode).toBe(400);
    expect(await fs.readFile(path.join(root, 'server.properties'), 'utf8')).toBe(PROPS);
  });

  it('accepts the EULA explicitly and audits it', async () => {
    const { app, root, instanceId, headers } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/config/eula`,
      headers,
      payload: { accept: true },
    });
    expect(res.statusCode).toBe(200);
    const raw = await fs.readFile(path.join(root, 'eula.txt'), 'utf8');
    expect(raw).toBe('#By changing the setting below to TRUE you are indicating your agreement\n_eula=true\n');
    const auditRow = ctx!.sqlite.prepare(`SELECT action FROM audit_logs WHERE action = 'instance.eula_accept'`).get();
    expect(auditRow).toBeTruthy();
  });
});
