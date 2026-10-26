import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearRuntime, isPidAlive, isPortOpen, readRuntime, stopOrphan, writeRuntime } from '../src/runtime';

const dirs: string[] = [];
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpanel-desktop-runtime-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('runtime metadata', () => {
  it('round-trips pid and port', () => {
    const file = path.join(temp(), 'runtime.json');
    writeRuntime(file, { pid: 1234, port: 3123 });
    expect(readRuntime(file)).toEqual({ pid: 1234, port: 3123 });
    clearRuntime(file);
    expect(readRuntime(file)).toBeNull();
  });

  it('rejects malformed entries', () => {
    const file = path.join(temp(), 'runtime.json');
    fs.writeFileSync(file, JSON.stringify({ pid: -1, port: 'x' }));
    expect(readRuntime(file)).toBeNull();
  });

  it('accepts the highest valid port and rejects out-of-range ports', () => {
    const file = path.join(temp(), 'runtime.json');

    fs.writeFileSync(file, JSON.stringify({ pid: 1234, port: 65535 }));
    expect(readRuntime(file)).toEqual({ pid: 1234, port: 65535 });

    fs.writeFileSync(file, JSON.stringify({ pid: 1234, port: 65536 }));
    expect(readRuntime(file)).toBeNull();

    fs.writeFileSync(file, JSON.stringify({ pid: 1234, port: 0 }));
    expect(readRuntime(file)).toBeNull();
  });

  it('creates nested directories, overwrites an existing file and leaves no temp file', () => {
    const file = path.join(temp(), 'nested', 'deeper', 'runtime.json');
    writeRuntime(file, { pid: 1234, port: 3123 });
    writeRuntime(file, { pid: 5678, port: 4123 });

    expect(readRuntime(file)).toEqual({ pid: 5678, port: 4123 });
    expect(fs.readdirSync(path.dirname(file))).toEqual(['runtime.json']);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it('clears a missing runtime file without throwing', () => {
    expect(() => clearRuntime(path.join(temp(), 'missing.json'))).not.toThrow();
  });
});

describe('isPortOpen', () => {
  it('detects a listening loopback port', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await expect(isPortOpen(port)).resolves.toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(isPortOpen(port)).resolves.toBe(false);
  });
});

describe('isPidAlive', () => {
  it('reports the current process as alive', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('treats EPERM as alive', () => {
    const error = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw error;
    });
    try {
      expect(isPidAlive(1234)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('stopOrphan', () => {
  const info = { pid: 1234, port: 3123 };

  it('does nothing when the saved pid is dead', async () => {
    const kill = vi.fn();
    await expect(stopOrphan(info, { isAlive: () => false, health: async () => true, kill })).resolves.toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('does not kill a reused pid when the panel health check fails', async () => {
    const kill = vi.fn();
    await expect(stopOrphan(info, { isAlive: () => true, health: async () => false, kill })).resolves.toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('kills only the saved panel pid when it answers health', async () => {
    let alive = true;
    const kill = vi.fn(() => {
      alive = false;
    });
    await expect(
      stopOrphan(info, {
        isAlive: () => alive,
        health: async () => true,
        kill,
        wait: async () => undefined,
      }),
    ).resolves.toBe(true);
    expect(kill).toHaveBeenCalledWith(1234);
  });

  it('succeeds when kill throws but the process is already gone', async () => {
    let alive = true;
    const kill = vi.fn(() => {
      // The process exited between the health check and the signal.
      alive = false;
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    });
    const wait = vi.fn(async () => undefined);
    await expect(stopOrphan(info, { isAlive: () => alive, health: async () => true, kill, wait })).resolves.toBe(true);
    expect(kill).toHaveBeenCalledWith(1234);
  });

  it('reports failure when kill throws and the process stays alive', async () => {
    const kill = vi.fn(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    });
    const wait = vi.fn(async () => undefined);
    await expect(stopOrphan(info, { isAlive: () => true, health: async () => true, kill, wait })).resolves.toBe(false);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(10);
  });
});
