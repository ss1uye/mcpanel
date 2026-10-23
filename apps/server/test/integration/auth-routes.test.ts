import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { SessionService } from '../../src/auth/session';
import { LoginThrottle } from '../../src/auth/guard';
import { loadConfig } from '../../src/config';
import { silentLogger } from '../../src/logger';
import { AuditService } from '../../src/services/audit-service';
import { auditLogs } from '../../src/db/schema';
import { createTestDb, type TestDb } from '../helpers/db';
import { CookieJar, TEST_ORIGIN, json } from '../helpers/http';

let ctx: TestDb | undefined;

async function makeApp(throttle = new LoginThrottle()) {
  ctx = createTestDb();
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: ctx.dir });
  const services = {
    sessions: new SessionService(ctx.db),
    audit: new AuditService(ctx.db),
    loginThrottle: throttle,
  };
  const app = await buildApp(config, ctx.db, services, { logger: silentLogger() });
  const jar = new CookieJar();
  const token = await refreshCsrf(app, jar);
  return { app, jar, token };
}

async function refreshCsrf(app: Awaited<ReturnType<typeof buildApp>>, jar: CookieJar): Promise<string> {
  const response = await app.inject({ method: 'GET', url: '/api/auth/csrf', headers: { cookie: jar.header() } });
  jar.absorb(response);
  return json<{ token: string }>(response).token;
}

afterEach(async () => {
  ctx?.close();
  ctx = undefined;
});

describe('auth routes', () => {
  it('runs first-run setup, reports status and logs out', async () => {
    const { app, jar, token } = await makeApp();

    const before = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(json<{ setupRequired: boolean }>(before).setupRequired).toBe(true);

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { origin: TEST_ORIGIN, cookie: jar.header(), 'x-csrf-token': token },
      payload: { username: 'admin', password: 'longpassword12' },
    });
    expect(setup.statusCode).toBe(200);
    jar.absorb(setup);
    expect(json<{ user: { username: string } }>(setup).user.username).toBe('admin');

    const status = await app.inject({ method: 'GET', url: '/api/auth/status', headers: { cookie: jar.header() } });
    expect(json<{ setupRequired: boolean; authenticated: boolean }>(status)).toMatchObject({
      setupRequired: false,
      authenticated: true,
    });

    const fresh = await refreshCsrf(app, jar);
    const again = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { origin: TEST_ORIGIN, cookie: jar.header(), 'x-csrf-token': fresh },
      payload: { username: 'other', password: 'longpassword12' },
    });
    expect(again.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(again).error.code).toBe('SETUP_COMPLETED');

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { origin: TEST_ORIGIN, cookie: jar.header(), 'x-csrf-token': fresh },
    });
    expect(logout.statusCode).toBe(204);

    const after = await app.inject({ method: 'GET', url: '/api/auth/status', headers: { cookie: jar.header() } });
    expect(json<{ authenticated: boolean }>(after).authenticated).toBe(false);

    const actions = ctx!.db.select({ action: auditLogs.action }).from(auditLogs).all().map((row) => row.action);
    expect(actions).toContain('setup.complete');
    expect(actions).toContain('auth.logout');
  });

  it('logs in, hides account existence and enforces CSRF and auth', async () => {
    const { app, jar, token } = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { origin: TEST_ORIGIN, cookie: jar.header(), 'x-csrf-token': token },
      payload: { username: 'admin', password: 'longpassword12' },
    });

    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: TEST_ORIGIN, cookie: jar.header(), 'x-csrf-token': token },
      payload: { username: 'nobody', password: 'longpassword12' },
    });
    expect(bad.statusCode).toBe(401);
    expect(json<{ error: { code: string; message: string } }>(bad).error).toMatchObject({
      code: 'INVALID_CREDENTIALS',
      message: '用户名或密码错误',
    });

    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: TEST_ORIGIN, cookie: jar.header() },
      payload: { username: 'admin', password: 'longpassword12' },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(noCsrf).error.code).toBe('CSRF_INVALID');

    const wrongOrigin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://evil.example', cookie: jar.header(), 'x-csrf-token': token },
      payload: { username: 'admin', password: 'longpassword12' },
    });
    expect(wrongOrigin.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(wrongOrigin).error.code).toBe('FORBIDDEN');

    const good = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: TEST_ORIGIN, cookie: jar.header(), 'x-csrf-token': token },
      payload: { username: 'admin', password: 'longpassword12' },
    });
    expect(good.statusCode).toBe(200);
    jar.absorb(good);

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: jar.header() } });
    expect(json<{ user: { username: string } }>(me).user.username).toBe('admin');

    const anonymous = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(anonymous.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(anonymous).error.code).toBe('AUTH_REQUIRED');

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(json<{ ok: boolean }>(health).ok).toBe(true);
  });

  it('changes the password and keeps only the current session', async () => {
    const { app, jar, token } = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { origin: TEST_ORIGIN, cookie: jar.header(), 'x-csrf-token': token },
      payload: { username: 'admin', password: 'longpassword12' },
    });
    jar.absorb(await app.inject({ method: 'GET', url: '/api/auth/status' }));
    const current = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: TEST_ORIGIN, cookie: jar.header(), 'x-csrf-token': token },
      payload: { username: 'admin', password: 'longpassword12' },
    });
    jar.absorb(current);
    const fresh = await refreshCsrf(app, jar);

    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { origin: TEST_ORIGIN, cookie: jar.header(), 'x-csrf-token': fresh },
      payload: { currentPassword: 'longpassword12', newPassword: 'another-long-password' },
    });
    expect(changed.statusCode).toBe(200);

    const stillValid = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: jar.header() } });
    expect(stillValid.statusCode).toBe(200);

    const otherSession = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: TEST_ORIGIN, cookie: jar.header(), 'x-csrf-token': fresh },
      payload: { username: 'admin', password: 'another-long-password' },
    });
    expect(otherSession.statusCode).toBe(200);

    const oldPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: TEST_ORIGIN, cookie: jar.header(), 'x-csrf-token': fresh },
      payload: { username: 'admin', password: 'longpassword12' },
    });
    expect(oldPassword.statusCode).toBe(401);
  });

  it('rate limits repeated login attempts from one address', async () => {
    const { app, jar, token } = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { origin: TEST_ORIGIN, cookie: jar.header(), 'x-csrf-token': token },
      payload: { username: 'admin', password: 'longpassword12' },
    });

    let status = 0;
    let code = '';
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: TEST_ORIGIN, cookie: jar.header(), 'x-csrf-token': token },
        payload: { username: 'admin', password: 'wrong-password-here' },
      });
      status = response.statusCode;
      code = json<{ error?: { code?: string } }>(response).error?.code ?? '';
    }
    expect(status).toBe(429);
    expect(code).toBe('LOGIN_RATE_LIMITED');
  });

  it('rejects unknown API routes and non-API paths consistently', async () => {
    const { app } = await makeApp();
    const missing = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(missing.statusCode).toBe(404);
    expect(json<{ error: { code: string } }>(missing).error.code).toBe('NOT_FOUND');
  });
});
