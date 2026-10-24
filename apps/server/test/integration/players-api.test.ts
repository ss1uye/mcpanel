import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { PlayersService } from '../../src/services/players-service';
import { ProbeService } from '../../src/services/probe-service';
import type { RconService } from '../../src/services/rcon-service';
import type { InstanceSupervisor } from '../../src/services/instance-supervisor';
import { insertInstance, insertUser } from '../helpers/factory';
import { createTestDb, type TestDb } from '../helpers/db';
import { CookieJar, TEST_ORIGIN, json } from '../helpers/http';

let ctx: TestDb | undefined;
const roots: string[] = [];

async function makeApp() {
  ctx = createTestDb();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-players-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'whitelist.json'), JSON.stringify([{ uuid: 'u1', name: 'Steve' }]));
  await fs.writeFile(path.join(root, 'ops.json'), JSON.stringify([{ uuid: 'u1', name: 'Steve', level: 4 }]));
  await fs.writeFile(path.join(root, 'banned-players.json'), JSON.stringify([{ uuid: 'u2', name: 'Herobrine' }]));
  await fs.writeFile(path.join(root, 'banned-ips.json'), JSON.stringify([{ ip: '10.0.0.9' }]));

  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: ctx.dir });
  const sessions = new SessionService(ctx.db);
  const { token } = sessions.create(insertUser(ctx.db), null, null);
  const instanceId = insertInstance(ctx.db, { rootPath: root });
  const sandbox = new PathSandbox(ctx.dir);
  const supervisor = {
    getStatus: () => ({ instanceId, state: 'running', pid: 5, startedAt: null, exitCode: null, error: null }),
  } as unknown as InstanceSupervisor;
  const send = vi.fn(async (_row: unknown, command: string) => {
    if (command === 'list') return 'There are 1 of a max of 20 players online: Steve';
    return `${command}: ok`;
  });
  const rcon = {
    statusFor: async () => 'connected',
    send,
    test: async () => ({ status: 'connected', error: null }),
  } as unknown as RconService;
  const players = new PlayersService(sandbox, rcon, () => 'running');
  const app = await buildApp(
    config,
    ctx.db,
    {
      sessions,
      audit: new AuditService(ctx.db),
      loginThrottle: new LoginThrottle(),
      instances: new InstanceService(ctx.db, ctx.dir),
      supervisor,
      rcon,
      driver: new LocalNodeDriver(sandbox),
      probe: new ProbeService(sandbox, async () => null),
      files: new FileService(sandbox),
      sandbox,
      players,
    },
    { logger: silentLogger() },
  );

  const jar = new CookieJar();
  const csrf = await app.inject({ method: 'GET', url: '/api/auth/csrf', headers: { cookie: `mcpanel_session=${token}` } });
  jar.absorb(csrf);
  jar.set('mcpanel_session', token);
  return {
    app,
    instanceId,
    send,
    headers: { origin: TEST_ORIGIN, cookie: jar.header(), 'x-csrf-token': json<{ token: string }>(csrf).token },
    readHeaders: { cookie: jar.header() },
  };
}

afterEach(async () => {
  ctx?.close();
  ctx = undefined;
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('players API', () => {
  it('returns the online list and read-only name lists', async () => {
    const { app, instanceId, readHeaders } = await makeApp();
    const players = await app.inject({ method: 'GET', url: `/api/instances/${instanceId}/players`, headers: readHeaders });
    expect(json<{ online: string[]; max: number }>(players)).toMatchObject({ online: ['Steve'], max: 20 });

    const lists = await app.inject({
      method: 'GET',
      url: `/api/instances/${instanceId}/players/lists`,
      headers: readHeaders,
    });
    expect(json(lists)).toEqual({ whitelist: ['Steve'], ops: ['Steve'], banned: ['Herobrine'], bannedIps: ['10.0.0.9'] });
  });

  it('runs whitelisted actions and audits them', async () => {
    const { app, instanceId, send, headers } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/players/actions`,
      headers,
      payload: { action: 'kick', player: 'Steve', reason: '挂机' },
    });
    expect(res.statusCode).toBe(200);
    expect(send).toHaveBeenCalledWith(expect.anything(), 'kick Steve 挂机');
    const row = ctx!.sqlite.prepare(`SELECT detail_json FROM audit_logs WHERE action = 'player.kick'`).get() as
      | { detail_json: string }
      | undefined;
    expect(row).toBeTruthy();
    expect(row!.detail_json).toContain('Steve');
  });

  it('rejects unknown player names and unsupported actions', async () => {
    const { app, instanceId, headers } = await makeApp();
    const badName = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/players/actions`,
      headers,
      payload: { action: 'op', player: 'not a name' },
    });
    expect(badName.statusCode).toBe(400);

    const unknownAction = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/players/actions`,
      headers,
      payload: { action: 'stop_server' },
    });
    expect(unknownAction.statusCode).toBe(400);
  });
});
