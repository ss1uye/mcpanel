import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServerEnv, findFreePort, ServerProcess, waitForHealth } from '../src/server-process';

const logFile = path.join(os.tmpdir(), `mcpanel-desktop-test-${process.pid}.log`);
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(logFile, { force: true });
});

class FakeChild extends EventEmitter {
  pid = 4242;
  connected = true;
  exitCode: number | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  send = vi.fn();
  kill = vi.fn(() => {
    this.exitCode = 0;
    this.emit('exit', 0);
  });
}

function fakeSpawn(child: FakeChild) {
  const mock = vi.fn((..._args: Parameters<typeof spawn>): ChildProcess => child as unknown as ChildProcess);
  return { mock, spawnFn: mock as unknown as typeof spawn };
}

describe('server process helpers', () => {
  it('builds the child environment', () => {
    expect(buildServerEnv(3123, 'D:\\data', { PATH: 'x' })).toMatchObject({
      PATH: 'x',
      NODE_ENV: 'production',
      PANEL_HOST: '127.0.0.1',
      PANEL_PORT: '3123',
      DATA_DIR: 'D:\\data',
    });
  });

  it('allocates a bindable loopback port', async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it('reports an unhealthy endpoint', async () => {
    expect(await waitForHealth(1, 50, 10)).toBe(false);
  });
});

describe('ServerProcess', () => {
  const options = {
    serverDir: 'D:\\app\\server',
    nodePath: 'D:\\app\\server\\node\\node.exe',
    entryPath: 'D:\\app\\server\\apps\\server\\dist\\index.js',
    dataDir: 'D:\\data',
    logFile,
    findPort: async () => 3123,
  };

  it('spawns the server with IPC and waits for health', async () => {
    const child = new FakeChild();
    const spawned = fakeSpawn(child);
    const server = new ServerProcess({
      ...options,
      waitHealth: async () => true,
      spawnFn: spawned.spawnFn,
    });

    await expect(server.start()).resolves.toEqual({ pid: 4242, port: 3123 });
    expect(server.pid).toBe(4242);
    expect(server.port).toBe(3123);
    expect(spawned.mock).toHaveBeenCalledTimes(1);
    const [command, args, spawnOptions] = spawned.mock.mock.calls[0]!;
    expect(command).toBe(options.nodePath);
    expect(args).toEqual([options.entryPath]);
    expect(spawnOptions).toMatchObject({
      cwd: options.serverDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    expect(spawnOptions.env).toMatchObject({
      NODE_ENV: 'production',
      PANEL_HOST: '127.0.0.1',
      PANEL_PORT: '3123',
      DATA_DIR: options.dataDir,
    });
  });

  it('kills the child when health never passes', async () => {
    const child = new FakeChild();
    const spawned = fakeSpawn(child);
    const server = new ServerProcess({
      ...options,
      waitHealth: async () => false,
      spawnFn: spawned.spawnFn,
    });

    await expect(server.start()).rejects.toThrow(/启动失败/);
    expect(child.kill).toHaveBeenCalled();
    expect(server.pid).toBeNull();
    expect(server.port).toBeNull();
  });

  it('sends shutdown and resolves after exit', async () => {
    const child = new FakeChild();
    const spawned = fakeSpawn(child);
    const server = new ServerProcess({
      ...options,
      waitHealth: async () => true,
      spawnFn: spawned.spawnFn,
    });
    await server.start();

    const stopping = server.stop(500);
    expect(child.send).toHaveBeenCalledWith('shutdown');
    child.exitCode = 0;
    child.emit('exit', 0);
    await expect(stopping).resolves.toBeUndefined();
    expect(server.pid).toBeNull();
    expect(server.port).toBeNull();
  });
});
