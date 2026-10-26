import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export interface RuntimeInfo {
  pid: number;
  port: number;
}

export interface OrphanDeps {
  isAlive?: (pid: number) => boolean;
  health?: (port: number) => Promise<boolean>;
  kill?: (pid: number) => void;
  wait?: (ms: number) => Promise<void>;
}

export function readRuntime(file: string): RuntimeInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RuntimeInfo>;
    if (
      typeof parsed.pid === 'number' &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.port === 'number' &&
      Number.isInteger(parsed.port) &&
      parsed.port > 0 &&
      parsed.port <= 65535
    ) {
      return { pid: parsed.pid, port: parsed.port };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeRuntime(file: string, info: RuntimeInfo): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(info)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

export function clearRuntime(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // already gone
  }
}

export function isPortOpen(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (open: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function stopOrphan(info: RuntimeInfo, deps: OrphanDeps = {}): Promise<boolean> {
  const isAlive = deps.isAlive ?? isPidAlive;
  const health = deps.health ?? (async () => false);
  const kill = deps.kill ?? ((pid: number) => process.kill(pid));
  const wait = deps.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  if (!isAlive(info.pid)) return false;
  // A reused PID must never be killed unless the saved port still answers as our panel.
  if (!(await health(info.port))) return false;
  try {
    kill(info.pid);
  } catch {
    // The process may have exited between the health check and the signal (ESRCH), or the signal may be
    // refused; fall through and let the liveness wait loop decide instead of reporting a false negative.
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!isAlive(info.pid)) return true;
    await wait(500);
  }
  return !isAlive(info.pid);
}
