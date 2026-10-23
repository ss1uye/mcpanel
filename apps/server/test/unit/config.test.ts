import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSafeBind, isLoopback, loadConfig } from '../../src/config';

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpanel-config-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
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
});
