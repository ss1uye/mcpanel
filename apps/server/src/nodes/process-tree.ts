import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { AppError } from '../utils/errors';

export function buildShellCommand(
  rootPath: string,
  startCommand: string,
  platform = process.platform,
): { file: string; args: string[]; verbatim: boolean } {
  const isWindows = platform === 'win32';
  if (isWindows) {
    // Windows paths cannot legally contain a double quote; reject it rather than
    // build a cmd.exe command line that could break out of its own quoting.
    if (rootPath.includes('"')) throw new AppError('INVALID_ROOT', '实例目录名包含非法字符');
    return {
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', `cd /d "${rootPath}" && ${startCommand}`],
      verbatim: true,
    };
  }
  const quoted = `'${rootPath.replaceAll("'", `'\\''`)}'`;
  // POSIX shells resolve a bare name through PATH, not the cwd; scripts detected
  // as `start.sh` would otherwise fail with "command not found".
  const trimmed = startCommand.trim();
  const first = trimmed.split(/\s+/, 1)[0] ?? '';
  const normalized = /^[A-Za-z0-9._-]+\.sh$/i.test(first) ? `./${trimmed}` : trimmed;
  return { file: '/bin/sh', args: ['-c', `cd -- ${quoted} && ${normalized}`], verbatim: false };
}

export function buildServerEnv(
  javaPath: string | null | undefined,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (!javaPath || !path.isAbsolute(javaPath)) return env;
  const binDir = path.dirname(javaPath);
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = env[pathKey] ? `${binDir}${path.delimiter}${env[pathKey]}` : binDir;
  const homeKey = Object.keys(env).find((key) => key.toLowerCase() === 'java_home') ?? 'JAVA_HOME';
  env[homeKey] = path.basename(binDir).toLowerCase() === 'bin' ? path.dirname(binDir) : binDir;
  return env;
}

export function spawnServer(
  rootPath: string,
  startCommand: string,
  javaPath?: string | null,
): ChildProcess {
  const { file, args, verbatim } = buildShellCommand(rootPath, startCommand);
  return spawn(file, args, {
    cwd: rootPath,
    env: buildServerEnv(javaPath),
    windowsHide: true,
    detached: process.platform !== 'win32',
    windowsVerbatimArguments: verbatim,
    stdio: ['pipe', 'pipe', 'pipe'],
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

export function processMatchesRoot(
  processes: { pid: number; command: string; params?: string }[],
  pid: number,
  rootPath: string,
): boolean | null {
  const found = processes.find((entry) => entry.pid === pid);
  if (!found) return false;
  const commandLine = `${found.command} ${found.params ?? ''}`.toLowerCase();
  if (!commandLine.trim()) return null;
  return commandLine.includes(rootPath.toLowerCase());
}

export async function killPidTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      child.on('error', () => reject(new AppError('KILL_FAILED', '无法启动 taskkill')));
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new AppError('KILL_FAILED', `taskkill 退出码 ${code}`)),
      );
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    try {
      process.kill(pid, 'SIGKILL');
    } catch (fallbackError) {
      if ((fallbackError as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw new AppError('KILL_FAILED', '无法结束进程');
      }
    }
  }
}
