import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  migrationsDir: string;
  webDistDir: string;
  cookieSecure: boolean;
  trustProxy: boolean;
  logLevel: string;
  maxUploadMb: number;
  sessionSecret: string;
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export function loadOrCreateSecret(dataDir: string): string {
  const file = path.join(dataDir, 'secret.key');
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length > 0) return existing;
  }
  const secret = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv =
    env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development';
  const dataDir = path.resolve(env.DATA_DIR ?? './data');
  for (const dir of [dataDir, path.join(dataDir, 'backups'), path.join(dataDir, 'tmp'), path.join(dataDir, 'logs')]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const port = Number(env.PANEL_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PANEL_PORT 无效：${env.PANEL_PORT}`);
  }

  return {
    nodeEnv,
    host: env.PANEL_HOST ?? '127.0.0.1',
    port,
    dataDir,
    dbPath: path.join(dataDir, 'panel.db'),
    migrationsDir: path.resolve('apps/server/drizzle'),
    webDistDir: path.resolve('apps/web/dist'),
    cookieSecure: env.COOKIE_SECURE === 'true',
    trustProxy: env.TRUST_PROXY === 'true',
    logLevel: env.LOG_LEVEL ?? 'info',
    maxUploadMb: Number(env.MAX_UPLOAD_MB ?? 1024),
    sessionSecret: loadOrCreateSecret(dataDir),
  };
}

export function assertSafeBind(host: string, setupRequired: boolean): void {
  if (!isLoopback(host) && setupRequired) {
    throw new Error(`首次初始化完成前只能绑定回环地址，当前 PANEL_HOST=${host}`);
  }
}
