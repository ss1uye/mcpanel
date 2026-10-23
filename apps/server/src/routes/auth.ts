import { randomUUID } from 'node:crypto';
import { count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  changePasswordSchema,
  loginSchema,
  SESSION_COOKIE,
  setupSchema,
  type AuthStatus,
  type UserInfo,
} from '@mcpanel/shared';
import { csrfUserInfo } from '../auth/guard';
import type { AppConfig } from '../config';
import type { DB } from '../db/client';
import { users } from '../db/schema';
import { hashPassword, verifyPassword } from '../auth/password';
import { createGuards, type LoginThrottle } from '../auth/guard';
import type { SessionService } from '../auth/session';
import type { AuditService } from '../services/audit-service';
import { AppError } from '../utils/errors';

export interface AuthRouteDeps {
  config: AppConfig;
  db: DB;
  sessions: SessionService;
  audit: AuditService;
  loginThrottle: LoginThrottle;
}

function toUserInfo(row: { id: string; username: string; role: 'admin' }): UserInfo {
  return { id: row.id, username: row.username, role: row.role };
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { config, db, sessions, audit, loginThrottle } = deps;
  const guards = createGuards(sessions);
  const userCount = (): number => db.select({ value: count() }).from(users).get()?.value ?? 0;

  app.get('/api/auth/status', async (request): Promise<AuthStatus> => {
    if (userCount() === 0) return { setupRequired: true, authenticated: false, user: null };
    const token = request.cookies[SESSION_COOKIE];
    const resolved = token ? sessions.resolve(token) : null;
    return {
      setupRequired: false,
      authenticated: Boolean(resolved),
      user: resolved ? toUserInfo(resolved.user) : null,
    };
  });

  app.get('/api/auth/csrf', async (request, reply) => {
    return { token: reply.generateCsrf({ userInfo: csrfUserInfo(request) }) };
  });

  app.post('/api/auth/setup', { preHandler: [guards.requireOrigin, app.csrfProtection] }, async (request, reply) => {
    const input = setupSchema.parse(request.body);
    if (userCount() > 0) throw new AppError('SETUP_COMPLETED', '面板已完成初始化');
    const passwordHash = await hashPassword(input.password);
    const id = randomUUID();
    const now = Date.now();
    db.insert(users).values({ id, username: input.username, passwordHash, role: 'admin', createdAt: now, updatedAt: now }).run();
    const { token } = sessions.create(id, request.ip, request.headers['user-agent'] ?? null);
    guards.setSessionCookie(reply, token, config.cookieSecure);
    audit.record({ userId: id, action: 'setup.complete', targetType: 'user', targetId: id, ip: request.ip });
    return { user: toUserInfo({ id, username: input.username, role: 'admin' }) };
  });

  app.post(
    '/api/auth/login',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      preHandler: [guards.requireOrigin, app.csrfProtection],
    },
    async (request, reply) => {
      const input = loginSchema.parse(request.body);
      loginThrottle.assertAllowed(request.ip);
      const row = db.select().from(users).where(eq(users.username, input.username)).get();
      const valid = row ? await verifyPassword(row.passwordHash, input.password) : false;
      if (!row || !valid) {
        loginThrottle.recordFailure(request.ip);
        audit.record({
          action: 'auth.login_failed',
          targetType: 'user',
          targetId: row?.id ?? null,
          detail: { username: input.username },
          ip: request.ip,
        });
        throw new AppError('INVALID_CREDENTIALS', '用户名或密码错误');
      }
      loginThrottle.recordSuccess(request.ip);
      const { token } = sessions.create(row.id, request.ip, request.headers['user-agent'] ?? null);
      guards.setSessionCookie(reply, token, config.cookieSecure);
      audit.record({ userId: row.id, action: 'auth.login', targetType: 'user', targetId: row.id, ip: request.ip });
      return { user: toUserInfo(row) };
    },
  );

  app.post(
    '/api/auth/logout',
    { preHandler: [guards.requireOrigin, guards.requireAuth, app.csrfProtection] },
    async (request, reply) => {
      if (request.sessionToken) sessions.delete(request.sessionToken);
      audit.record({
        userId: request.user?.id,
        action: 'auth.logout',
        targetType: 'user',
        targetId: request.user?.id ?? null,
        ip: request.ip,
      });
      guards.clearSessionCookie(reply);
      return reply.status(204).send();
    },
  );

  app.get('/api/auth/me', { preHandler: [guards.requireAuth] }, async (request) => {
    return { user: toUserInfo(request.user!) };
  });

  app.post(
    '/api/auth/password',
    { preHandler: [guards.requireOrigin, guards.requireAuth, app.csrfProtection] },
    async (request) => {
      const input = changePasswordSchema.parse(request.body);
      const current = db.select().from(users).where(eq(users.id, request.user!.id)).get();
      if (!current || !(await verifyPassword(current.passwordHash, input.currentPassword))) {
        throw new AppError('VALIDATION_ERROR', '当前密码错误', { field: 'currentPassword' });
      }
      const passwordHash = await hashPassword(input.newPassword);
      db.update(users).set({ passwordHash, updatedAt: Date.now() }).where(eq(users.id, current.id)).run();
      sessions.deleteOtherSessions(current.id, request.sessionToken!);
      audit.record({
        userId: current.id,
        action: 'auth.password_change',
        targetType: 'user',
        targetId: current.id,
        ip: request.ip,
      });
      return { ok: true };
    },
  );
}
