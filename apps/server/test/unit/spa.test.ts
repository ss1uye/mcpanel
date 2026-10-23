import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, shouldServeSpa } from '../../src/app';
import { LoginThrottle } from '../../src/auth/guard';
import { SessionService } from '../../src/auth/session';
import { loadConfig } from '../../src/config';
import { silentLogger } from '../../src/logger';
import { AuditService } from '../../src/services/audit-service';
import { createTestDb, type TestDb } from '../helpers/db';

describe('shouldServeSpa', () => {
  it('serves the SPA only for GET navigation outside the API namespace', () => {
    expect(shouldServeSpa('/instances/abc/console', 'GET')).toBe(true);
    expect(shouldServeSpa('/', 'GET')).toBe(true);
    expect(shouldServeSpa('/api/instances', 'GET')).toBe(false);
    expect(shouldServeSpa('/api/nope', 'GET')).toBe(false);
    expect(shouldServeSpa('/api/ws', 'GET')).toBe(false);
    expect(shouldServeSpa('/instances', 'POST')).toBe(false);
    expect(shouldServeSpa('/apixyz', 'GET')).toBe(false);
  });

  it('ignores the query string when matching the API prefix', () => {
    expect(shouldServeSpa('/api/audit?page=1', 'GET')).toBe(false);
    expect(shouldServeSpa('/instances?search=a', 'GET')).toBe(true);
  });

  it('does not answer file-like requests with the SPA shell', () => {
    expect(shouldServeSpa('/assets/app.js', 'GET')).toBe(false);
    expect(shouldServeSpa('/favicon.png', 'GET')).toBe(false);
    expect(shouldServeSpa('/index.html', 'GET')).toBe(true);
  });
});

describe('SPA hosting', () => {
  let db: TestDb | undefined;
  let webDist: string | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (webDist) fs.rmSync(webDist, { recursive: true, force: true });
    webDist = undefined;
  });

  it('serves the built shell for client routes and JSON 404 for API misses', async () => {
    db = createTestDb();
    webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpanel-web-'));
    fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><title>MC Panel</title>');
    fs.mkdirSync(path.join(webDist, 'assets'));
    fs.writeFileSync(path.join(webDist, 'assets', 'app.js'), 'export const loaded = true;');

    const config = { ...loadConfig({ NODE_ENV: 'test', DATA_DIR: db.dir }), webDistDir: webDist };
    const app = await buildApp(
      config,
      db.db,
      { sessions: new SessionService(db.db), audit: new AuditService(db.db), loginThrottle: new LoginThrottle() },
      { logger: silentLogger(), serveStatic: true },
    );

    const page = await app.inject({ method: 'GET', url: '/instances/abc/console' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('MC Panel');

    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);

    const missingAsset = await app.inject({ method: 'GET', url: '/assets/nope.js' });
    expect(missingAsset.statusCode).toBe(404);

    const api = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(api.statusCode).toBe(404);
    expect(api.json().error.code).toBe('NOT_FOUND');

    await app.close();
  });
});
