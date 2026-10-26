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

type ServerState = 'idle' | 'starting' | 'running' | 'stopping';

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
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      const body = response.body;
      if (body) await body.cancel().catch(() => undefined);
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
  private state: ServerState = 'idle';
  private startFailure: ((error: Error) => void) | null = null;
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
    if (this.state !== 'idle') throw new Error('面板服务已在运行');
    this.state = 'starting';
    try {
      const port = await this.findPort();
      this.currentPort = port;
      await fsp.mkdir(path.dirname(this.options.logFile), { recursive: true });
      const logStream = fs.createWriteStream(this.options.logFile, { flags: 'a' });
      this.logStream = logStream;
      logStream.on('error', (error) => {
        if (this.logStream !== logStream) return;
        this.emit('server-error', error);
        this.closeLog();
      });

      let child: ChildProcess;
      try {
        child = this.spawnFn(this.options.nodePath, [this.options.entryPath], {
          cwd: this.options.serverDir,
          env: buildServerEnv(port, this.options.dataDir),
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
      } catch (error) {
        this.closeLog();
        throw error;
      }
      this.child = child;
      const isCurrent = (): boolean => this.child === child;
      child.stdout?.pipe(logStream, { end: false });
      child.stderr?.pipe(logStream, { end: false });
      child.on('close', () => {
        if (isCurrent()) this.closeLog();
      });

      let failStart!: (error: Error) => void;
      const failure = new Promise<never>((_resolve, reject) => {
        failStart = reject;
      });
      this.startFailure = failStart;
      void failure.catch(() => undefined);

      child.on('exit', (code) => {
        if (isCurrent()) this.handleExit(code);
      });
      child.on('error', (error) => {
        if (!isCurrent()) return;
        this.emit('server-error', error);
        if (this.state === 'starting') {
          this.startFailure?.(
            new Error(`无法启动面板服务：${error.message}（日志：${this.options.logFile}）`),
          );
        }
      });

      // A failed spawn reports no pid synchronously; give Node one tick to emit
      // the underlying error instead of waiting out the health timeout.
      if (!child.pid) {
        await Promise.race([new Promise((resolve) => setTimeout(resolve, 100)), failure]);
        if (!child.pid) throw new Error(`无法启动面板服务（日志：${this.options.logFile}）`);
      }

      const healthy = await Promise.race([this.waitHealth(port), failure]);
      if (!healthy) throw new Error(`面板服务启动失败，请查看 ${this.options.logFile}`);
      if (!child.pid) throw new Error('面板服务没有返回 PID');

      this.state = 'running';
      this.startFailure = null;
      return { pid: child.pid, port };
    } catch (error) {
      this.startFailure = null;
      if (this.state === 'starting') this.state = 'stopping';
      if (this.child?.pid) await this.killChild();
      else {
        this.child = null;
        this.currentPort = null;
      }
      this.closeLog();
      this.state = 'idle';
      throw error;
    }
  }

  async stop(timeoutMs = 12_000): Promise<void> {
    if (this.state === 'starting') throw new Error('面板正在启动，无法停止');
    if (this.state === 'stopping') return;
    const child = this.child;
    if (!child) {
      this.state = 'idle';
      return;
    }
    this.state = 'stopping';
    // Only the panel child is signalled: Minecraft servers it started must keep running.
    if (child.connected) {
      try {
        child.send('shutdown');
      } catch {
        // The IPC channel can close between the connected check and send.
      }
    }
    const exited = await waitForExit(child, timeoutMs);
    if (!exited) await this.killChild();
    this.state = 'idle';
    this.child = null;
    this.currentPort = null;
    this.closeLog();
  }

  private handleExit(code: number | null): void {
    const previous = this.state;
    this.child = null;
    this.currentPort = null;
    this.state = 'idle';
    this.closeLog();
    if (previous === 'starting') {
      this.startFailure?.(
        new Error(`面板服务在启动完成前退出（退出码 ${code ?? 'unknown'}；日志：${this.options.logFile}）`),
      );
      return;
    }
    if (previous === 'running') this.emit('exit', code);
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
    if (this.child === child) {
      this.child = null;
      this.currentPort = null;
      this.closeLog();
    }
  }

  private closeLog(): void {
    const stream = this.logStream;
    this.logStream = null;
    if (!stream) return;
    try {
      stream.end();
    } catch {
      // already closed
    }
  }
}
