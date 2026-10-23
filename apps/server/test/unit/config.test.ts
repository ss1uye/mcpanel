import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSafeBind, isLoopback, loadConfig } from '../../src/config';

const dirs: string[] = [];
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const defaultDataDir = path.join(repoRoot, 'data');
const defaultDataDirExisted = fs.existsSync(defaultDataDir);

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpanel-config-'));
  dirs.push(dir);
  return dir;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  if (!defaultDataDirExisted) fs.rmSync(defaultDataDir, { recursive: true, force: true });
});

describe('config', () => {
  it('creates data directories and reuses the generated secret', () => {
    const dataDir = tempDir();
    const first = loadConfig({ NODE_ENV: 'test', DATA_DIR: dataDir });
    expect(fs.existsSync(path.join(dataDir, 'backups'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'secret.key'))).toBe(true);
    const second = loadConfig({ NODE_ENV: 'test', DATA_DIR: dataDir });
    expect(second.sessionSecret).toBe(first.sessionSecret);
    expect(first.dbPath).toBe(path.join(dataDir, 'panel.db'));
  });

  it('resolves migrations and web assets relative to the module, not the cwd', () => {
    const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: tempDir() });
    expect(toPosix(config.migrationsDir)).toMatch(/\/apps\/server\/drizzle$/);
    expect(toPosix(config.webDistDir)).toMatch(/\/apps\/web\/dist$/);
  });

  it('resolves the default data dir from the repo root', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.dataDir).toBe(defaultDataDir);
    expect(isInside(repoRoot, config.dataDir)).toBe(true);
    expect(isInside(path.join(repoRoot, 'apps', 'server'), config.dataDir)).toBe(false);
  });

  it('detects loopback hosts', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('localhost')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('192.168.1.10')).toBe(false);
  });

  it('refuses non-loopback binding before setup', () => {
    expect(() => assertSafeBind('0.0.0.0', true)).toThrow(/回环/);
    expect(() => assertSafeBind('0.0.0.0', false)).not.toThrow();
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ DATA_DIR: tempDir(), PANEL_PORT: '99999' })).toThrow(/PANEL_PORT/);
  });

  it.each(['abc', '0', '-5', '1.5'])('rejects invalid MAX_UPLOAD_MB %s', (maxUploadMb) => {
    const dataDir = tempDir();
    expect(() => loadConfig({ NODE_ENV: 'test', DATA_DIR: dataDir, MAX_UPLOAD_MB: maxUploadMb })).toThrow(
      /MAX_UPLOAD_MB/,
    );
    expect(fs.existsSync(path.join(dataDir, 'backups'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'secret.key'))).toBe(false);
  });

  it('treats empty and whitespace environment values as unset', () => {
    const config = loadConfig({
      NODE_ENV: '   ',
      PANEL_HOST: ' ',
      PANEL_PORT: '',
      DATA_DIR: tempDir(),
      COOKIE_SECURE: '',
      TRUST_PROXY: '\t',
      LOG_LEVEL: '  ',
      MAX_UPLOAD_MB: ' ',
    });
    expect(config.nodeEnv).toBe('development');
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3000);
    expect(config.cookieSecure).toBe(false);
    expect(config.trustProxy).toBe(false);
    expect(config.logLevel).toBe('info');
    expect(config.maxUploadMb).toBe(1024);
  });

  it('parses boolean values case-insensitively', () => {
    const dataDir = tempDir();
    const truthy = loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      COOKIE_SECURE: 'TRUE',
      TRUST_PROXY: '1',
    });
    expect(truthy.cookieSecure).toBe(true);
    expect(truthy.trustProxy).toBe(true);

    const falsy = loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      COOKIE_SECURE: 'False',
      TRUST_PROXY: '0',
    });
    expect(falsy.cookieSecure).toBe(false);
    expect(falsy.trustProxy).toBe(false);
  });

  it('rejects invalid boolean values', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', DATA_DIR: tempDir(), COOKIE_SECURE: 'yes' })).toThrow(
      /COOKIE_SECURE/,
    );
    expect(() => loadConfig({ NODE_ENV: 'test', DATA_DIR: tempDir(), TRUST_PROXY: 'on' })).toThrow(
      /TRUST_PROXY/,
    );
  });

  it('rejects unknown NODE_ENV values', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging', DATA_DIR: tempDir() })).toThrow(/NODE_ENV/);
  });

  it('replaces an empty secret file with a valid secret', () => {
    const dataDir = tempDir();
    fs.writeFileSync(path.join(dataDir, 'secret.key'), '   ');
    const first = loadConfig({ NODE_ENV: 'test', DATA_DIR: dataDir });
    expect(first.sessionSecret.length).toBeGreaterThan(0);
    expect(first.sessionSecret.trim()).toBe(first.sessionSecret);
    const second = loadConfig({ NODE_ENV: 'test', DATA_DIR: dataDir });
    expect(second.sessionSecret).toBe(first.sessionSecret);
  });
});
