import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app';
import { LoginThrottle } from '../../src/auth/guard';
import { SessionService } from '../../src/auth/session';
import { loadConfig } from '../../src/config';
import { silentLogger } from '../../src/logger';
import { AuditService } from '../../src/services/audit-service';
import { InstanceService } from '../../src/services/instance-service';
import { ScheduleService } from '../../src/services/schedule-service';
import { SettingsService } from '../../src/services/settings-service';
import { insertInstance, insertUser } from '../helpers/factory';
import { createTestDb, type TestDb } from '../helpers/db';
import { CookieJar, TEST_ORIGIN, json } from '../helpers/http';

let ctx: TestDb | undefined;
let dir: string;

async function makeApp() {
  ctx = createTestDb();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-schedules-api-'));
  const root = path.join(dir, 'server');
  await fs.mkdir(root, { recursive: true });
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: dir });
  const sessions = new SessionService(ctx.db);
  const { token } = sessions.create(insertUser(ctx.db), null, null);
  const instanceId = insertInstance(ctx.db, { rootPath: root });
  const instances = new InstanceService(ctx.db, dir);
  const settings = new SettingsService(ctx.db);
  const sendCommand = vi.fn(async () => undefined);
  const supervisor = {
    getStatus: () => ({ instanceId, state: 'running', pid: 5, startedAt: null, exitCode: null, error: null }),
    sendCommand,
  } as never;
  const schedules = new ScheduleService({
    db: ctx.db,
    instances,
    supervisor,
    backups: { startCreate: vi.fn() } as never,
    audit: new AuditService(ctx.db),
    logger: silentLogger(),
  });
  const app = await buildApp(
    config,
    ctx.db,
    {
      sessions,
      audit: new AuditService(ctx.db),
      loginThrottle: new LoginThrottle(),
      instances,
      settings,
      schedules,
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
    sendCommand,
    headers: { origin: TEST_ORIGIN, cookie: jar.header(), 'x-csrf-token': json<{ token: string }>(csrf).token },
    readHeaders: { cookie: jar.header() },
  };
}

afterEach(async () => {
  ctx?.close();
  ctx = undefined;
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe('schedules API', () => {
  it('creates a schedule with the panel timezone default and lists it', async () => {
    const { app, instanceId, headers, readHeaders } = await makeApp();
    const created = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/schedules`,
      headers,
      payload: { name: '每晚命令', cron: '0 4 * * *', actionType: 'command', command: 'save-all' },
    });
    expect(created.statusCode).toBe(201);
    expect(json(created)).toMatchObject({ timezone: 'Asia/Shanghai', actionType: 'command', enabled: true });

    const list = await app.inject({
      method: 'GET',
      url: `/api/instances/${instanceId}/schedules`,
      headers: readHeaders,
    });
    expect(json<{ items: unknown[] }>(list).items).toHaveLength(1);
  });

  it('rejects an invalid cron with INVALID_CRON', async () => {
    const { app, instanceId, headers } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/schedules`,
      headers,
      payload: { name: '坏计划', cron: 'every day', actionType: 'backup' },
    });
    expect(res.statusCode).toBe(400);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('INVALID_CRON');
  });

  it('returns next runs and previews a cron for the form', async () => {
    const { app, instanceId, headers, readHeaders } = await makeApp();
    const created = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/schedules`,
      headers,
      payload: { name: '每日备份', cron: '0 4 * * *', actionType: 'backup' },
    });
    expect(created.statusCode).toBe(201);
    expect(json<{ nextRuns: string[] }>(created).nextRuns).toHaveLength(3);

    const list = await app.inject({
      method: 'GET',
      url: `/api/instances/${instanceId}/schedules`,
      headers: readHeaders,
    });
    expect(json<{ items: Array<{ nextRuns: string[] }> }>(list).items[0]!.nextRuns).toHaveLength(3);

    const preview = await app.inject({
      method: 'GET',
      url: `/api/instances/${instanceId}/schedules/preview?cron=${encodeURIComponent('*/5 * * * *')}&timezone=${encodeURIComponent('Asia/Shanghai')}`,
      headers: readHeaders,
    });
    expect(preview.statusCode).toBe(200);
    expect(json<{ nextRuns: string[] }>(preview).nextRuns).toHaveLength(3);

    const bad = await app.inject({
      method: 'GET',
      url: `/api/instances/${instanceId}/schedules/preview?cron=every-day&timezone=Asia%2FShanghai`,
      headers: readHeaders,
    });
    expect(bad.statusCode).toBe(400);
    expect(json<{ error: { code: string } }>(bad).error.code).toBe('INVALID_CRON');
  });

  it('runs a schedule manually and returns the run record', async () => {
    const { app, instanceId, headers, sendCommand } = await makeApp();
    const created = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/schedules`,
      headers,
      payload: { name: '命令', cron: '0 * * * *', actionType: 'command', command: 'list' },
    });
    const scheduleId = json<{ id: string }>(created).id;
    const run = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/schedules/${scheduleId}/run`,
      headers,
    });
    expect(run.statusCode).toBe(200);
    expect(json(run)).toMatchObject({ trigger: 'manual', status: 'success' });
    expect(sendCommand).toHaveBeenCalledWith(instanceId, 'list');

    const runs = await app.inject({
      method: 'GET',
      url: `/api/instances/${instanceId}/schedules/${scheduleId}/runs`,
      headers: { cookie: headers.cookie },
    });
    expect(json<{ items: unknown[] }>(runs).items).toHaveLength(1);
  });

  it('updates enabled state and deletes the schedule', async () => {
    const { app, instanceId, headers } = await makeApp();
    const created = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/schedules`,
      headers,
      payload: { name: '备份', cron: '0 3 * * *', actionType: 'backup' },
    });
    const scheduleId = json<{ id: string }>(created).id;
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/instances/${instanceId}/schedules/${scheduleId}`,
      headers,
      payload: { enabled: false },
    });
    expect(json(patched)).toMatchObject({ enabled: false, nextRunAt: null });
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/instances/${instanceId}/schedules/${scheduleId}`,
      headers,
    });
    expect(removed.statusCode).toBe(204);
  });
});
