import cookie from '@fastify/cookie';
import csrf from '@fastify/csrf-protection';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { PANEL_VERSION } from '@mcpanel/shared';
import { csrfUserInfo, type LoginThrottle } from './auth/guard';
import type { SessionService } from './auth/session';
import type { AppConfig } from './config';
import type { DB } from './db/client';
import { silentLogger } from './logger';
import { registerAuditRoutes } from './routes/audit';
import { registerAuthRoutes } from './routes/auth';
import { registerInstanceRoutes } from './routes/instances';
import { registerSystemRoutes } from './routes/system';
import type { LocalNodeDriver } from './nodes/local-driver';
import type { AuditService } from './services/audit-service';
import type { InstanceService } from './services/instance-service';
import type { InstanceSupervisor } from './services/instance-supervisor';
import type { MetricsService } from './services/metrics-service';
import type { ProbeService } from './services/probe-service';
import type { RconService } from './services/rcon-service';
import { AppError } from './utils/errors';
import { WsHub } from './ws/hub';

export interface AppServices {
  sessions: SessionService;
  audit: AuditService;
  loginThrottle: LoginThrottle;
  instances?: InstanceService;
  supervisor?: InstanceSupervisor;
  rcon?: RconService;
  driver?: LocalNodeDriver;
  probe?: ProbeService;
  metrics?: MetricsService;
}

export interface BuildAppOptions {
  logger?: FastifyBaseLogger;
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '),
};

export async function buildApp(
  config: AppConfig,
  db: DB,
  services: AppServices,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: options.logger ?? silentLogger(),
    trustProxy: config.trustProxy,
  });

  await app.register(cookie);
  await app.register(websocket);
  await app.register(csrf, {
    cookieOpts: { path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure },
    getUserInfo: csrfUserInfo,
    csrfOpts: { hmacKey: config.sessionSecret },
  });
  await app.register(rateLimit, { global: false });

  app.decorateRequest('user', null);
  app.decorateRequest('sessionToken', null);

  app.addHook('onSend', async (_request, reply, payload) => {
    for (const [header, value] of Object.entries(SECURITY_HEADERS)) reply.header(header, value);
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.status).send({
        error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
      });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: '参数校验失败',
          details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        },
      });
    }
    const code = (error as { code?: string }).code ?? '';
    if (code.startsWith('FST_CSRF')) {
      return reply.status(403).send({ error: { code: 'CSRF_INVALID', message: 'CSRF token 缺失或无效' } });
    }
    if (code.startsWith('FST_ERR_CTP')) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: '请求格式不正确' } });
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.status(429).send({ error: { code: 'LOGIN_RATE_LIMITED', message: '请求过于频繁，请稍后再试' } });
    }
    request.log.error({ err: error, url: request.url, method: request.method }, 'request failed');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: '资源不存在' } });
  });

  app.get('/api/health', async () => ({ ok: true, version: PANEL_VERSION }));

  registerAuthRoutes(app, {
    config,
    db,
    sessions: services.sessions,
    audit: services.audit,
    loginThrottle: services.loginThrottle,
  });

  registerAuditRoutes(app, { sessions: services.sessions, audit: services.audit });

  if (services.instances && services.supervisor && services.rcon && services.driver && services.probe) {
    registerInstanceRoutes(app, {
      sessions: services.sessions,
      audit: services.audit,
      instances: services.instances,
      supervisor: services.supervisor,
      rcon: services.rcon,
      driver: services.driver,
      probe: services.probe,
    });
  }

  let hub: WsHub | null = null;
  if (services.metrics && services.supervisor) {
    hub = new WsHub({
      db,
      sessions: services.sessions,
      supervisor: services.supervisor,
      metrics: services.metrics,
    });
    hub.register(app);
    registerSystemRoutes(app, { sessions: services.sessions, metrics: services.metrics });
  }

  app.addHook('onClose', async () => {
    hub?.closeAll();
    services.metrics?.stop();
  });

  return app;
}
