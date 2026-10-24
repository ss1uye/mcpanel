import cookie from '@fastify/cookie';
import csrf from '@fastify/csrf-protection';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { ZodError } from 'zod';
import { PANEL_VERSION } from '@mcpanel/shared';
import { csrfUserInfo, type LoginThrottle } from './auth/guard';
import type { SessionService } from './auth/session';
import type { AppConfig } from './config';
import type { DB } from './db/client';
import { silentLogger } from './logger';
import { registerAuditRoutes } from './routes/audit';
import { registerAuthRoutes } from './routes/auth';
import { registerBackupRoutes } from './routes/backups';
import { registerConfigRoutes } from './routes/config';
import { registerFileRoutes } from './routes/files';
import { registerInstanceRoutes } from './routes/instances';
import { registerPlayerRoutes } from './routes/players';
import { registerRconRoutes } from './routes/rcon';
import { registerScheduleRoutes } from './routes/schedules';
import { registerSettingsRoutes } from './routes/settings';
import { registerSystemRoutes } from './routes/system';
import type { LocalNodeDriver } from './nodes/local-driver';
import type { PathSandbox } from './nodes/path-sandbox';
import type { AuditService } from './services/audit-service';
import type { BackupService } from './services/backup-service';
import type { FileService } from './services/file-service';
import type { InstanceService } from './services/instance-service';
import type { InstanceSupervisor } from './services/instance-supervisor';
import type { PanelBackupService } from './services/panel-backup-service';
import type { PlayersService } from './services/players-service';
import type { MetricsService } from './services/metrics-service';
import type { ProbeService } from './services/probe-service';
import type { RconConfigService } from './services/rcon-config-service';
import type { RconService } from './services/rcon-service';
import type { RestoreService } from './services/restore-service';
import type { ScheduleService } from './services/schedule-service';
import type { SettingsService } from './services/settings-service';
import type { TaskTracker } from './services/task-tracker';
import { AppError } from './utils/errors';
import { WsHub } from './ws/hub';

declare module 'fastify' {
  interface FastifyRequest {
    cspNonce: string;
  }
}

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
  files?: FileService;
  sandbox?: PathSandbox;
  rconConfig?: RconConfigService;
  players?: PlayersService;
  settings?: SettingsService;
  panelBackup?: PanelBackupService;
  backups?: BackupService;
  restore?: RestoreService;
  tasks?: TaskTracker;
  schedules?: ScheduleService;
}

export interface BuildAppOptions {
  logger?: FastifyBaseLogger;
  serveStatic?: boolean;
}

/** Client-side routes must fall back to index.html, but API misses and asset requests must not. */
export function shouldServeSpa(url: string, method: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const pathname = url.split('?', 1)[0] ?? url;
  if (pathname.startsWith('/api')) return false;
  const isFileLike = path.extname(pathname) !== '';
  return !isFileLike || pathname.endsWith('.html');
}

const BASE_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

const HOST_PATTERN = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

export function buildCsp(host: string | undefined, nonce: string): string {
  const connect = ["'self'"];
  if (host && HOST_PATTERN.test(host)) connect.push(`ws://${host}`, `wss://${host}`);
  return [
    "default-src 'self'",
    "script-src 'self'",
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect.join(' ')}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

export function renderIndex(template: string, nonce: string): string {
  const replaced = template.replaceAll('__CSP_NONCE__', nonce);
  if (replaced.includes('name="csp-nonce"')) return replaced;
  return replaced.includes('</head>')
    ? replaced.replace('</head>', `<meta name="csp-nonce" content="${nonce}" /></head>`)
    : replaced;
}

export async function buildApp(
  config: AppConfig,
  db: DB,
  services: AppServices,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: options.logger ?? silentLogger(),
    trustProxy: config.trustProxy,
    // The dashboard polls system metrics every 15s; per-request lines would drown real signals.
    logController: new LogController({ disableRequestLogging: true }),
  });

  await app.register(cookie);
  await app.register(websocket);
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1, fields: 4 },
  });
  await app.register(csrf, {
    cookieOpts: { path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure },
    getUserInfo: csrfUserInfo,
    csrfOpts: { hmacKey: config.sessionSecret },
  });
  await app.register(rateLimit, { global: false });

  app.decorateRequest('user', null);
  app.decorateRequest('sessionToken', null);
  app.decorateRequest('cspNonce', '');
  app.addHook('onRequest', async (request) => {
    request.cspNonce = randomBytes(16).toString('base64');
  });

  app.addHook('onSend', async (request, reply, payload) => {
    for (const [header, value] of Object.entries(BASE_SECURITY_HEADERS)) reply.header(header, value);
    reply.header('Content-Security-Policy', buildCsp(request.headers.host, request.cspNonce));
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
    if (code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.status(413).send({ error: { code: 'FILE_TOO_LARGE', message: '上传超过大小限制' } });
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.status(429).send({ error: { code: 'LOGIN_RATE_LIMITED', message: '请求过于频繁，请稍后再试' } });
    }
    request.log.error({ err: error, url: request.url, method: request.method }, 'request failed');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
  });

  const serveStatic = options.serveStatic ?? config.nodeEnv !== 'test';
  const hasSpa = serveStatic && fs.existsSync(path.join(config.webDistDir, 'index.html'));
  const indexTemplate = hasSpa ? fs.readFileSync(path.join(config.webDistDir, 'index.html'), 'utf8') : '';
  const sendIndex = (request: FastifyRequest, reply: FastifyReply) =>
    reply
      .type('text/html')
      .header('Cache-Control', 'no-store')
      .send(renderIndex(indexTemplate, request.cspNonce));

  if (hasSpa) {
    await app.register(fastifyStatic, { root: config.webDistDir, index: false });
    app.get('/', sendIndex);
    app.get('/index.html', sendIndex);
  }

  app.setNotFoundHandler((request, reply) => {
    if (hasSpa && shouldServeSpa(request.url, request.method)) return sendIndex(request, reply);
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

  if (services.settings) {
    registerSettingsRoutes(app, {
      sessions: services.sessions,
      audit: services.audit,
      settings: services.settings,
      panelBackup: services.panelBackup,
    });
  }

  if (services.instances && services.schedules && services.settings) {
    registerScheduleRoutes(app, {
      sessions: services.sessions,
      audit: services.audit,
      instances: services.instances,
      schedules: services.schedules,
      settings: services.settings,
    });
  }

  if (services.instances && services.supervisor && services.rcon && services.driver && services.probe) {
    registerInstanceRoutes(app, {
      sessions: services.sessions,
      audit: services.audit,
      instances: services.instances,
      supervisor: services.supervisor,
      rcon: services.rcon,
      driver: services.driver,
      probe: services.probe,
      schedules: services.schedules,
    });
  }

  if (services.instances && services.backups && services.restore) {
    registerBackupRoutes(app, {
      sessions: services.sessions,
      audit: services.audit,
      instances: services.instances,
      backups: services.backups,
      restore: services.restore,
    });
  }

  if (services.instances && services.files) {
    registerFileRoutes(app, {
      sessions: services.sessions,
      audit: services.audit,
      instances: services.instances,
      files: services.files,
      config,
    });
  }

  if (services.instances && services.rcon && services.sandbox) {
    registerConfigRoutes(app, {
      sessions: services.sessions,
      audit: services.audit,
      instances: services.instances,
      rcon: services.rcon,
      sandbox: services.sandbox,
    });
  }

  if (services.instances && services.rcon && services.rconConfig) {
    registerRconRoutes(app, {
      sessions: services.sessions,
      audit: services.audit,
      instances: services.instances,
      rcon: services.rcon,
      rconConfig: services.rconConfig,
    });
  }

  if (services.instances && services.players) {
    registerPlayerRoutes(app, {
      sessions: services.sessions,
      audit: services.audit,
      instances: services.instances,
      players: services.players,
    });
  }

  let hub: WsHub | null = null;
  if (services.metrics && services.supervisor && services.tasks) {
    hub = new WsHub({
      db,
      sessions: services.sessions,
      supervisor: services.supervisor,
      metrics: services.metrics,
      tasks: services.tasks,
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
