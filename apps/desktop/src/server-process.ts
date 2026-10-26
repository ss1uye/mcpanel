import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

export interface ServerStartInfo {
  pid: number;
  port: number;
}

export interface ServerProcessOptions {
  serverDir: string;
  nodePath: string;
  entryPath: string;
  dataDir: string;
  logFile: string;
  findPort?: () => Promise<number>;
  waitHealth?: (port: number) => Promise<boolean>;
  spawnFn?: typeof spawn;
}

export function buildServerEnv(
  port: number,
  dataDir: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    NODE_ENV: 'production',
    PANEL_HOST: '127.0.0.1',
    PANEL_PORT: String(port),
    DATA_DIR: dataDir,
  };
}

export async function findFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error('无法分配空闲端口');
  return port;
}

export async function waitForHealth(port: number, timeoutMs = 30_000, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return true;
    } catch {
      // The panel is still booting; retry until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref();
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

export class ServerProcess extends EventEmitter {
  private child: ChildProcess | null = null;
  private logStream: fs.WriteStream | null = null;
  private currentPort: number | null = null;
  private readonly findPort: () => Promise<number>;
  private readonly waitHealth: (port: number) => Promise<boolean>;
  private readonly spawnFn: typeof spawn;

  constructor(private readonly options: ServerProcessOptions) {
    super();
    this.findPort = options.findPort ?? findFreePort;
    this.waitHealth = options.waitHealth ?? ((port) => waitForHealth(port));
    this.spawnFn = options.spawnFn ?? spawn;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get port(): number | null {
    return this.currentPort;
  }

  async start(): Promise<ServerStartInfo> {
    if (this.child) throw new Error('面板服务已在运行');
    const port = await this.findPort();
    await fsp.mkdir(path.dirname(this.options.logFile), { recursive: true });
    this.logStream = fs.createWriteStream(this.options.logFile, { flags: 'a' });

    let child: ChildProcess;
    try {
      child = this.spawnFn(this.options.nodePath, [this.options.entryPath], {
        cwd: this.options.serverDir,
        env: buildServerEnv(port, this.options.dataDir),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    } catch (error) {
      this.logStream.end();
      this.logStream = null;
      throw error;
    }

    this.child = child;
    this.currentPort = port;
    child.stdout?.pipe(this.logStream, { end: false });
    child.stderr?.pipe(this.logStream, { end: false });
    child.on('exit', (code) => {
      this.child = null;
      this.currentPort = null;
      this.logStream?.end();
      this.logStream = null;
      this.emit('exit', code);
    });
    child.on('error', (error) => this.emit('server-error', error));

    const healthy = await this.waitHealth(port);
    if (!healthy) {
      await this.killChild();
      throw new Error(`面板服务启动失败，请查看 ${this.options.logFile}`);
    }
    if (!child.pid) {
      await this.killChild();
      throw new Error('面板服务没有返回 PID');
    }
    return { pid: child.pid, port };
  }

  async stop(timeoutMs = 10_000): Promise<void> {
    const child = this.child;
    if (!child) return;
    // Only the panel child is signalled: Minecraft servers it started must keep running.
    if (child.connected) child.send('shutdown');
    const exited = await waitForExit(child, timeoutMs);
    if (!exited) await this.killChild();
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      child.kill();
    } catch {
      // The child is already gone.
    }
    await waitForExit(child, 5_000);
  }
}
