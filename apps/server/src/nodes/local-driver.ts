import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import iconv from 'iconv-lite';
import si from 'systeminformation';
import {
  CONSOLE_HISTORY_BYTES,
  type LogEncoding,
  type ProcessSnapshot,
  type RootValidation,
  type StartSpec,
} from '@mcpanel/shared';
import { AppError } from '../utils/errors';
import { stripAnsi } from '../utils/ansi';
import type { FileEntry, NodeDriver, TextFile } from './driver';
import type { PathSandbox } from './path-sandbox';
import { isPidAlive, killPidTree, processMatchesRoot, spawnServer } from './process-tree';

interface ProcessEntry {
  child: ChildProcess;
  startedAt: number;
}

export interface DriverOutputEvent {
  instanceId: string;
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface DriverExitEvent {
  instanceId: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export class LocalNodeDriver extends EventEmitter implements NodeDriver {
  private readonly processes = new Map<string, ProcessEntry>();

  constructor(private readonly sandbox: PathSandbox) {
    super();
  }

  validateRoot(rootPath: string, otherRoots: string[]): Promise<RootValidation> {
    return this.sandbox.validateRoot(rootPath, otherRoots);
  }

  async listFiles(root: string, relPath: string): Promise<FileEntry[]> {
    const dir = await this.sandbox.resolve(root, relPath);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const result: FileEntry[] = [];
    for (const entry of entries) {
      if (entry.name === '.mcpanel-tmp') continue;
      const absolute = path.join(dir, entry.name);
      const stat = await fs.lstat(absolute);
      result.push({
        name: entry.name,
        type: stat.isDirectory() ? 'directory' : 'file',
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        symlink: stat.isSymbolicLink(),
      });
    }
    return result.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1,
    );
  }

  async readText(root: string, relPath: string): Promise<TextFile> {
    const file = await this.sandbox.resolve(root, relPath);
    const stat = await fs.stat(file);
    if (stat.size > MAX_TEXT_BYTES) throw new AppError('FILE_TOO_LARGE', '文件超过 2 MB');
    const raw = await fs.readFile(file);
    if (raw.includes(0)) throw new AppError('UNSUPPORTED_FILE', '这是二进制文件');
    return { content: raw.toString('utf8'), mtime: stat.mtimeMs };
  }

  async startProcess(spec: StartSpec): Promise<ProcessSnapshot> {
    if (this.processes.has(spec.instanceId)) throw new AppError('OPERATION_IN_PROGRESS', '进程已在运行');
    const child = spawnServer(spec.rootPath, spec.startCommand, spec.javaPath);
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => reject(new AppError('INTERNAL', `无法启动进程：${spec.startCommand}`)));
    });
    const pid = child.pid;
    if (!pid) throw new AppError('INTERNAL', '无法获得进程 PID');

    const decoder = iconv.getDecoder(spec.logEncoding);
    let pending = '';
    const emitText = (stream: 'stdout' | 'stderr', chunk: string) => {
      pending += chunk;
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() ?? '';
      for (const part of parts) {
        const text = stripAnsi(part);
        if (text.trim()) this.emit('output', { instanceId: spec.instanceId, stream, text } satisfies DriverOutputEvent);
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => emitText('stdout', decoder.write(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => emitText('stderr', decoder.write(chunk)));

    const startedAt = Date.now();
    let reported = false;
    const reportExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (reported) return;
      reported = true;
      emitText('stdout', decoder.end() ?? '');
      if (pending.trim()) {
        const text = stripAnsi(pending);
        if (text) this.emit('output', { instanceId: spec.instanceId, stream: 'stdout', text } satisfies DriverOutputEvent);
      }
      pending = '';
      this.processes.delete(spec.instanceId);
      this.emit('exit', { instanceId: spec.instanceId, code, signal } satisfies DriverExitEvent);
    };
    child.on('exit', (code, signal) => reportExit(code, signal));
    child.on('error', () => reportExit(child.exitCode, child.signalCode));

    this.processes.set(spec.instanceId, { child, startedAt });
    return { instanceId: spec.instanceId, pid, startedAt };
  }

  async stopProcess(instanceId: string, timeoutSec: number): Promise<{ forced: boolean }> {
    const entry = this.processes.get(instanceId);
    if (!entry?.child.pid) return { forced: false };
    const exited = exitedOnce(entry.child);
    if (entry.child.stdin && !entry.child.stdin.destroyed) entry.child.stdin.write('stop\n');

    const timedOut = await Promise.race([exited.then(() => false), delay(timeoutSec * 1000).then(() => true)]);
    if (!timedOut) return { forced: false };

    if (isPidAlive(entry.child.pid)) await killPidTree(entry.child.pid);
    await exited;
    return { forced: true };
  }

  async killProcessTree(instanceId: string): Promise<void> {
    const entry = this.processes.get(instanceId);
    if (!entry?.child.pid) throw new AppError('INVALID_STATE', '没有可结束的进程');
    const exited = exitedOnce(entry.child);
    if (isPidAlive(entry.child.pid)) await killPidTree(entry.child.pid);
    await Promise.race([exited, delay(5000)]);
  }

  async writeStdin(instanceId: string, line: string): Promise<void> {
    const entry = this.processes.get(instanceId);
    if (!entry?.child.stdin || entry.child.stdin.destroyed) throw new AppError('INVALID_STATE', '控制台不可用');
    entry.child.stdin.write(`${line}\n`);
  }

  getProcessSnapshot(instanceId: string): ProcessSnapshot | null {
    const entry = this.processes.get(instanceId);
    if (!entry?.child.pid) return null;
    return { instanceId, pid: entry.child.pid, startedAt: entry.startedAt };
  }

  async verifyPid(pid: number, rootPath: string): Promise<boolean> {
    const processes = await si.processes();
    return processMatchesRoot(processes.list, pid, rootPath) !== false;
  }

  async readLogTail(rootPath: string, encoding: LogEncoding, bytes = CONSOLE_HISTORY_BYTES): Promise<string[]> {
    try {
      const file = path.join(rootPath, 'logs', 'latest.log');
      const stat = await fs.stat(file);
      const start = Math.max(0, stat.size - bytes);
      const handle = await fs.open(file, 'r');
      try {
        const buffer = Buffer.alloc(stat.size - start);
        await handle.read(buffer, 0, buffer.length, start);
        return iconv.decode(buffer, encoding).split(/\r?\n/).filter((line) => line.trim().length > 0);
      } finally {
        await handle.close();
      }
    } catch {
      return [];
    }
  }
}

function exitedOnce(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
