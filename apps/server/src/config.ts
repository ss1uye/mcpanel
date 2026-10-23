import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type NodeEnv = 'development' | 'production' | 'test';

export interface AppConfig {
  nodeEnv: NodeEnv;
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

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const defaultMigrationsDir = fileURLToPath(new URL('../drizzle', import.meta.url));
const defaultWebDistDir = fileURLToPath(new URL('../../web/dist', import.meta.url));

const nodeEnvs: readonly NodeEnv[] = ['development', 'production', 'test'];

function readString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseNodeEnv(env: NodeJS.ProcessEnv): NodeEnv {
  const raw = readString(env, 'NODE_ENV');
  if (raw === undefined) return 'development';
  if ((nodeEnvs as readonly string[]).includes(raw)) return raw as NodeEnv;
  throw new Error(`NODE_ENV 无效：${raw}（仅支持 ${nodeEnvs.join('、')}）`);
}

function parsePort(env: NodeJS.ProcessEnv): number {
  const raw = readString(env, 'PANEL_PORT');
  const port = Number(raw ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PANEL_PORT 无效：${raw ?? ''}`);
  }
  return port;
}

function parseBoolean(env: NodeJS.ProcessEnv, key: string): boolean {
  const raw = readString(env, key);
  if (raw === undefined) return false;
  const normalized = raw.toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new Error(`${key} 无效：${raw}（仅接受 true、false、1、0）`);
}

function parseMaxUploadMb(env: NodeJS.ProcessEnv): number {
  const raw = readString(env, 'MAX_UPLOAD_MB');
  if (raw === undefined) return 1024;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`MAX_UPLOAD_MB 无效：${raw}（必须为正整数）`);
  }
  return value;
}

function restrictSecretPermissions(file: string): void {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort: some mounted filesystems do not support chmod.
  }
}

function readSecret(file: string): string | undefined {
  let existing: string;
  try {
    existing = fs.readFileSync(file, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (existing.length === 0) {
    fs.rmSync(file, { force: true });
    return undefined;
  }
  restrictSecretPermissions(file);
  return existing;
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export function loadOrCreateSecret(dataDir: string): string {
  const file = path.join(dataDir, 'secret.key');
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const existing = readSecret(file);
    if (existing !== undefined) return existing;

    const secret = crypto.randomBytes(32).toString('base64url');
    try {
      fs.writeFileSync(file, secret, { flag: 'wx', mode: 0o600 });
      return secret;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`无法创建密钥文件：${file}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Validate every scalar value before touching the filesystem.
  const nodeEnv = parseNodeEnv(env);
  const host = readString(env, 'PANEL_HOST') ?? '127.0.0.1';
  const port = parsePort(env);
  const dataDirEnv = readString(env, 'DATA_DIR');
  const dataDir = path.resolve(repoRoot, dataDirEnv ?? 'data');
  const cookieSecure = parseBoolean(env, 'COOKIE_SECURE');
  const trustProxy = parseBoolean(env, 'TRUST_PROXY');
  const logLevel = readString(env, 'LOG_LEVEL') ?? 'info';
  const maxUploadMb = parseMaxUploadMb(env);

  for (const dir of [
    dataDir,
    path.join(dataDir, 'backups'),
    path.join(dataDir, 'tmp'),
    path.join(dataDir, 'logs'),
  ]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  return {
    nodeEnv,
    host,
    port,
    dataDir,
    dbPath: path.join(dataDir, 'panel.db'),
    migrationsDir: defaultMigrationsDir,
    webDistDir: defaultWebDistDir,
    cookieSecure,
    trustProxy,
    logLevel,
    maxUploadMb,
    sessionSecret: loadOrCreateSecret(dataDir),
  };
}

export function assertSafeBind(host: string, setupRequired: boolean): void {
  if (!isLoopback(host) && setupRequired) {
    throw new Error(`首次初始化完成前只能绑定回环地址，当前 PANEL_HOST=${host}`);
  }
}
