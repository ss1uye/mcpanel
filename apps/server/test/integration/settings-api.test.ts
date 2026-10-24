import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { buildApp } from '../../src/app';
import { LoginThrottle } from '../../src/auth/guard';
import { SessionService } from '../../src/auth/session';
import { loadConfig } from '../../src/config';
import { silentLogger } from '../../src/logger';
import { AuditService } from '../../src/services/audit-service';
import { PanelBackupService } from '../../src/services/panel-backup-service';
import { SettingsService } from '../../src/services/settings-service';
import { insertUser } from '../helpers/factory';
import { createTestDb, type TestDb } from '../helpers/db';
import { CookieJar, TEST_ORIGIN, json } from '../helpers/http';

let ctx: TestDb | undefined;

async function makeApp() {
  ctx = createTestDb();
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: ctx.dir });
  const sessions = new SessionService(ctx.db);
  const { token } = sessions.create(insertUser(ctx.db), null, null);
  const audit = new AuditService(ctx.db);
  audit.record({ action: 'instance.create', targetType: 'instance', targetId: 'a' });
  audit.record({ action: 'player.kick', targetType: 'instance', targetId: 'a' });
  const panelBackup = new PanelBackupService({ sqlite: ctx.sqlite, dataDir: ctx.dir });
  const app = await buildApp(
    config,
    ctx.db,
    {
      sessions,
      audit,
      loginThrottle: new LoginThrottle(),
      settings: new SettingsService(ctx.db),
      panelBackup,
    },
    { logger: silentLogger() },
  );
  const jar = new CookieJar();
  const csrf = await app.inject({ method: 'GET', url: '/api/auth/csrf', headers: { cookie: `mcpanel_session=${token}` } });
  jar.absorb(csrf);
  jar.set('mcpanel_session', token);
  return {
    app,
    headers: { origin: TEST_ORIGIN, cookie: jar.header(), 'x-csrf-token': json<{ token: string }>(csrf).token },
    readHeaders: { cookie: jar.header() },
  };
}

afterEach(() => {
  ctx?.close();
  ctx = undefined;
});

describe('settings API', () => {
  it('returns defaults and persists partial updates', async () => {
    const { app, headers, readHeaders } = await makeApp();
    expect(json(await app.inject({ method: 'GET', url: '/api/settings', headers: readHeaders }))).toEqual({
      panelName: 'MC Panel',
      defaultTimezone: 'Asia/Shanghai',
      auditRetentionDays: 90,
    });
    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers,
      payload: { panelName: '生存服面板', auditRetentionDays: 30 },
    });
    expect(patched.statusCode).toBe(200);
    expect(json(patched)).toMatchObject({
      panelName: '生存服面板',
      auditRetentionDays: 30,
      defaultTimezone: 'Asia/Shanghai',
    });

    const reread = await app.inject({ method: 'GET', url: '/api/settings', headers: readHeaders });
    expect(json(reread)).toMatchObject({ panelName: '生存服面板' });
  });

  it('rejects an invalid timezone', async () => {
    const { app, headers } = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers,
      payload: { defaultTimezone: 'Mars/Base' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('streams a consistent panel database snapshot and audits it', async () => {
    const { app, readHeaders } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/settings/panel-backup', headers: readHeaders });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('application/vnd.sqlite3');
    const filename = /filename="([^"]+)"/.exec(String(res.headers['content-disposition']))?.[1];
    expect(filename).toMatch(/^panel-.*\.db$/);
    expect(res.rawPayload.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\u0000');

    const copy = path.join(ctx!.dir, 'snapshot-copy.db');
    await fs.writeFile(copy, res.rawPayload);
    const snapshot = new Database(copy, { readonly: true });
    try {
      expect(snapshot.prepare('SELECT COUNT(*) AS value FROM users').get()).toEqual({ value: 1 });
    } finally {
      snapshot.close();
    }

    const audit = await app.inject({
      method: 'GET',
      url: '/api/audit?page=1&pageSize=20&action=panel.backup',
      headers: readHeaders,
    });
    expect(json<{ items: Array<{ action: string }> }>(audit).items.map((item) => item.action)).toEqual([
      'panel.backup',
    ]);

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const files = await fs.readdir(path.join(ctx!.dir, 'tmp'));
      if (!files.some((file) => file.startsWith('panel-'))) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect((await fs.readdir(path.join(ctx!.dir, 'tmp'))).filter((file) => file.startsWith('panel-'))).toEqual([]);
  });

  it('filters the audit log by action prefix', async () => {
    const { app, readHeaders } = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit?page=1&pageSize=20&action=instance.',
      headers: readHeaders,
    });
    const body = json<{ items: Array<{ action: string }> }>(res);
    expect(body.items.map((item) => item.action)).toEqual(['instance.create']);
  });
});
