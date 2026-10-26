import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearRuntime, readRuntime, stopOrphan, writeRuntime } from '../src/runtime';

const dirs: string[] = [];
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpanel-desktop-runtime-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
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
});
