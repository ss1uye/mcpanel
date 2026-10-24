import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { count } from 'drizzle-orm';
import { buildApp } from './app';
import { LoginThrottle } from './auth/guard';
import { SessionService } from './auth/session';
import { assertSafeBind, loadConfig } from './config';
import { openDatabase } from './db/client';
import { runMigrations, seedLocalNode } from './db/migrate';
import { users } from './db/schema';
import { createLogger } from './logger';
import { LocalNodeDriver } from './nodes/local-driver';
import { PathSandbox } from './nodes/path-sandbox';
import { AuditService } from './services/audit-service';
import { FileService } from './services/file-service';
import { InstanceService } from './services/instance-service';
import { InstanceSupervisor } from './services/instance-supervisor';
import { MetricsService } from './services/metrics-service';
import { ProbeService } from './services/probe-service';
import { RconConfigService } from './services/rcon-config-service';
import { RconService } from './services/rcon-service';

const SHUTDOWN_TIMEOUT_MS = 10_000;

// Resolved from the module, not the cwd: `npm run dev -w @mcpanel/server` starts inside apps/server.
const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();
const logger = createLogger(config.dataDir, config.logLevel, config.nodeEnv === 'development');
const handle = openDatabase(config.dbPath);
runMigrations(handle.sqlite, config.migrationsDir);
seedLocalNode(handle.db);

const userCount = handle.db.select({ value: count() }).from(users).get()?.value ?? 0;
assertSafeBind(config.host, userCount === 0);

const sessions = new SessionService(handle.db);
const audit = new AuditService(handle.db, logger);
const instances = new InstanceService(handle.db, config.dataDir);
const sandbox = new PathSandbox(config.dataDir);
const files = new FileService(sandbox);
const driver = new LocalNodeDriver(sandbox);
const rcon = new RconService();
const rconConfig = new RconConfigService(sandbox, instances, rcon);
const probe = new ProbeService(sandbox);
const supervisor = new InstanceSupervisor({ db: handle.db, driver, rcon, audit, logger, dataDir: config.dataDir });

await supervisor.init();

const metrics = new MetricsService({ supervisor, db: handle.db, dataDir: config.dataDir });
const serveStatic = config.nodeEnv === 'production';
if (serveStatic && !fs.existsSync(path.join(config.webDistDir, 'index.html'))) {
  logger.warn({ webDistDir: config.webDistDir }, '未找到前端构建产物，请先运行 npm run build 后再启动面板');
}
const app = await buildApp(
  config,
  handle.db,
  { sessions, audit, loginThrottle: new LoginThrottle(), instances, supervisor, rcon, driver, probe, metrics, files, sandbox, rconConfig },
  { logger, serveStatic },
);

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EADDRINUSE') {
    logger.fatal({ host: config.host, port: config.port }, `端口 ${config.port} 已被占用，请设置 PANEL_PORT 更换端口`);
  } else if (code === 'EACCES') {
    logger.fatal(
      { host: config.host, port: config.port },
      `无权监听 ${config.host}:${config.port}，1024 以下的端口需要管理员权限`,
    );
  } else {
    logger.fatal({ err: error }, '面板启动失败');
  }
  await supervisor.shutdown().catch(() => undefined);
  handle.sqlite.close();
  process.exit(1);
}
logger.info({ host: config.host, port: config.port, dataDir: config.dataDir }, 'MC Panel started');
if (userCount === 0) logger.info('尚未初始化管理员，请使用面板首页完成初始化');

let shuttingDown = false;
async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) {
    // A second signal means the first one is stuck: leave immediately rather than hang.
    process.exit(exitCode);
    return;
  }
  shuttingDown = true;
  logger.info({ reason }, 'shutting down panel; Minecraft servers keep running');
  const guard = setTimeout(() => process.exit(exitCode), SHUTDOWN_TIMEOUT_MS);
  guard.unref();
  try {
    await supervisor.shutdown();
    await app.close();
  } catch (error) {
    logger.error({ err: error }, '关闭过程中出错');
    exitCode = exitCode || 1;
  } finally {
    clearTimeout(guard);
    handle.sqlite.close();
  }
  process.exit(exitCode);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal, 0));
}

for (const event of ['unhandledRejection', 'uncaughtException'] as const) {
  process.on(event, (reason) => {
    logger.fatal({ err: reason }, event);
    void shutdown(event, 1);
  });
}
