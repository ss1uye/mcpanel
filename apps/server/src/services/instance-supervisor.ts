import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type {
  ConsoleLine,
  InstanceState,
  InstanceStatusSnapshot,
  LogEncoding,
} from '@mcpanel/shared';
import type { DB } from '../db/client';
import { instances, type InstanceRow } from '../db/schema';
import { detectJava, type JavaInfo } from '../nodes/java-detect';
import type { LocalNodeDriver } from '../nodes/local-driver';
import { isPortFree } from '../nodes/port-check';
import { isPidAlive, killPidTree } from '../nodes/process-tree';
import { AppError } from '../utils/errors';
import type { AuditService } from './audit-service';
import { type ConsoleSnapshot, ConsoleBuffer, classifyLevel } from './console-buffer';
import { loadServerProperties, parsePort, propertyValue } from './properties-service';
import type { RconService } from './rcon-service';
import { transition, type InstanceAction } from './state-machine';

interface RuntimeState {
  state: InstanceState;
  pid: number | null;
  startedAt: number | null;
  exitCode: number | null;
  error: string | null;
}

export interface SupervisorDeps {
  db: DB;
  driver: LocalNodeDriver;
  rcon: RconService;
  audit: AuditService;
  logger: Logger;
  dataDir: string;
  detectJava?: (javaPath: string | null) => Promise<JavaInfo | null>;
  portFree?: (port: number) => Promise<boolean>;
}

const STARTUP_TIMEOUT_MS = 300_000;
const STARTUP_RCON_POLL_MS = 5_000;
const COMMAND_LIMIT_PER_MINUTE = 30;
const ORPHAN_STOP_TIMEOUT_MS = 60_000;
const STARTUP_PATTERNS = [/Done \(/, /For help, type "help"/i, /Listening on \//i];
const FAILURE_HINTS: { pattern: RegExp; message: string }[] = [
  { pattern: /Failed to load eula\.txt/i, message: 'eula.txt 未接受或格式错误' },
  { pattern: /Address already in use/i, message: '端口已被占用' },
  { pattern: /UnsupportedClassVersionError/i, message: 'Java 版本过低，请更换 Java' },
  {
    pattern: /Unsupported class file major version/i,
    message: 'Java 版本与 Mixin 不兼容，请改用服务端要求的 Java 版本',
  },
  { pattern: /Java heap space/i, message: 'Java 堆内存不足' },
];
const STARTUP_FATAL_HINTS = [
  {
    pattern: /Unsupported class file major version/i,
    message: 'Java 版本与 Mixin 不兼容，请改用服务端要求的 Java 版本',
  },
  { pattern: /UnsupportedClassVersionError/i, message: 'Java 版本过低，请更换 Java' },
];

export class InstanceSupervisor extends EventEmitter {
  private readonly runtime = new Map<string, RuntimeState>();
  private readonly buffers = new Map<string, ConsoleBuffer>();
  private readonly timers = new Map<string, NodeJS.Timeout[]>();
  private readonly locks = new Set<string>();
  private readonly commandTimes = new Map<string, number[]>();
  private readonly aborting = new Set<string>();
  private closing = false;

  constructor(private readonly deps: SupervisorDeps) {
    super();
    this.deps.driver.on('output', (event: { instanceId: string; stream: 'stdout' | 'stderr'; text: string }) => {
      const line = this.getBuffer(event.instanceId).append({
        stream: event.stream,
        level: classifyLevel(event.text),
        text: event.text,
      });
      this.emit('console', event.instanceId, [line]);
      if (this.runtime.get(event.instanceId)?.state === 'starting') {
        const fatal = STARTUP_FATAL_HINTS.find((item) => item.pattern.test(event.text));
        if (fatal) {
          this.abortStartup(event.instanceId, fatal.message);
          return;
        }
        if (STARTUP_PATTERNS.some((pattern) => pattern.test(event.text))) this.markRunning(event.instanceId);
      }
    });
    this.deps.driver.on('exit', (event: { instanceId: string; code: number | null }) => {
      this.handleExit(event.instanceId, event.code);
    });
  }

  async init(): Promise<void> {
    const rows = this.deps.db.select().from(instances).all();
    for (const row of rows) {
      this.runtime.set(row.id, {
        state: row.lastState,
        pid: row.lastPid,
        startedAt: row.lastStartedAt,
        exitCode: row.lastExitCode,
        error: row.lastError,
      });
    }
    for (const row of rows) await this.recover(row);
  }

  /** Drops all in-memory state for an instance that has been unregistered. */
  forget(instanceId: string): void {
    this.runtime.delete(instanceId);
    this.buffers.delete(instanceId);
    this.clearTimers(instanceId);
  }

  getStatus(instanceId: string): InstanceStatusSnapshot {
    const row = this.readRow(instanceId);
    const state = this.runtime.get(instanceId);
    return {
      instanceId,
      state: state?.state ?? row?.lastState ?? 'stopped',
      pid: state?.pid ?? row?.lastPid ?? null,
      startedAt: state?.startedAt ? new Date(state.startedAt).toISOString() : null,
      exitCode: state?.exitCode ?? row?.lastExitCode ?? null,
      error: state?.error ?? row?.lastError ?? null,
    };
  }

  start(instanceId: string): Promise<InstanceStatusSnapshot> {
    return this.withLock(instanceId, () => this.startInternal(instanceId));
  }

  stop(instanceId: string): Promise<void> {
    return this.withLock(instanceId, () => this.stopInternal(instanceId));
  }

  restart(instanceId: string): Promise<void> {
    return this.withLock(instanceId, async () => {
      const state = this.requireRuntime(instanceId).state;
      if (!['running', 'orphaned', 'stopped', 'crashed'].includes(state)) {
        throw new AppError('INVALID_STATE', `当前状态 ${state} 不能重启`);
      }
      if (state === 'running' || state === 'orphaned') await this.stopInternal(instanceId);
      await this.startInternal(instanceId);
    });
  }

  kill(instanceId: string): Promise<void> {
    return this.withLock(instanceId, async () => {
      const runtime = this.requireRuntime(instanceId);
      if (!runtime.pid) throw new AppError('INVALID_STATE', '没有记录到进程 PID');
      const pid = runtime.pid;
      if (['starting', 'running', 'stopping'].includes(runtime.state)) {
        this.move(instanceId, 'kill_requested', {});
        try {
          await this.deps.driver.killProcessTree(instanceId);
        } catch (error) {
          if ((error as AppError).code !== 'INVALID_STATE') throw error;
        }
        if (isPidAlive(pid)) throw new AppError('KILL_FAILED', '进程未能结束');
        if (this.requireRuntime(instanceId).state !== 'stopped') {
          this.updateState(instanceId, 'stopped', { pid: null });
        }
      } else if (runtime.state === 'orphaned' || runtime.state === 'unknown') {
        try {
          await killPidTree(pid);
        } catch (error) {
          if (isPidAlive(pid)) throw error;
        }
        this.updateState(instanceId, 'stopped', { pid: null, error: null });
      } else {
        throw new AppError('INVALID_STATE', `当前状态 ${runtime.state} 不能强制结束`);
      }
      this.deps.audit.record({ action: 'instance.kill', targetType: 'instance', targetId: instanceId });
    });
  }

  markStopped(instanceId: string): Promise<void> {
    return this.withLock(instanceId, async () => {
      const runtime = this.requireRuntime(instanceId);
      if (runtime.state !== 'unknown' && runtime.state !== 'crashed') {
        throw new AppError('INVALID_STATE', '仅 unknown/crashed 可以标记为已停止');
      }
      if (runtime.pid && isPidAlive(runtime.pid)) {
        throw new AppError('INVALID_STATE', '进程仍在运行，请先强制结束');
      }
      this.move(instanceId, 'mark_stopped', { pid: null, error: null });
      this.deps.audit.record({ action: 'instance.mark_stopped', targetType: 'instance', targetId: instanceId });
    });
  }

  async sendCommand(instanceId: string, command: string): Promise<void> {
    const row = this.getInstance(instanceId);
    const runtime = this.requireRuntime(instanceId);
    this.checkCommandRate(instanceId);
    if (runtime.state === 'running') {
      await this.deps.driver.writeStdin(instanceId, command);
      return;
    }
    if (runtime.state === 'orphaned') {
      const response = await this.deps.rcon.send(row, command);
      const line = this.getBuffer(instanceId).append({
        stream: 'rcon',
        level: 'info',
        text: response.trim() ? `> ${command}\n${response}` : `> ${command}`,
      });
      this.emit('console', instanceId, [line]);
      return;
    }
    throw new AppError('INVALID_STATE', '服务器未运行，无法发送命令');
  }

  async getConsoleSnapshot(instanceId: string, sinceSeq?: number): Promise<ConsoleSnapshot> {
    await this.ensureHistory(instanceId);
    return this.getBuffer(instanceId).since(sinceSeq);
  }

  async getRecentLines(instanceId: string, limit: number): Promise<ConsoleLine[]> {
    await this.ensureHistory(instanceId);
    return this.getBuffer(instanceId).snapshot().slice(-limit);
  }

  getLogFilePath(instanceId: string): string {
    return path.join(this.getInstance(instanceId).rootPath, 'logs', 'latest.log');
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    for (const instanceId of [...this.timers.keys()]) this.clearTimers(instanceId);
    this.deps.rcon.closeAll();
  }

  private async startInternal(instanceId: string): Promise<InstanceStatusSnapshot> {
    const row = this.getInstance(instanceId);
    const runtime = this.requireRuntime(instanceId);
    if (runtime.state !== 'stopped' && runtime.state !== 'crashed') {
      throw new AppError('INVALID_STATE', `当前状态 ${runtime.state} 不能启动`);
    }
    await this.validateStart(row);
    this.aborting.delete(instanceId);
    this.move(instanceId, 'start_requested', { pid: null, startedAt: Date.now(), exitCode: null, error: null });
    try {
      const snapshot = await this.deps.driver.startProcess({
        instanceId,
        rootPath: row.rootPath,
        startCommand: row.startCommand,
        logEncoding: row.logEncoding as LogEncoding,
        javaPath: row.javaPath,
      });
      this.updateState(instanceId, this.requireRuntime(instanceId).state, {
        pid: snapshot.pid,
        startedAt: snapshot.startedAt,
      });
      this.scheduleStartupChecks(row);
      this.deps.audit.record({ action: 'instance.start', targetType: 'instance', targetId: instanceId });
      return this.getStatus(instanceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateState(instanceId, 'crashed', { pid: null, error: message });
      throw new AppError('INTERNAL', `启动失败：${message}`);
    }
  }

  private async validateStart(row: InstanceRow): Promise<void> {
    try {
      await fs.access(row.rootPath);
    } catch {
      throw new AppError('INVALID_ROOT', '实例目录不存在');
    }
    try {
      const eula = await fs.readFile(path.join(row.rootPath, 'eula.txt'), 'utf8');
      if (!/^[ \t]*eula[ \t]*=[ \t]*true[ \t]*$/im.test(eula)) {
        throw new AppError('EULA_NOT_ACCEPTED', '请先接受 EULA');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const java = await (this.deps.detectJava ?? detectJava)(row.javaPath);
    if (!java) throw new AppError('JAVA_NOT_FOUND', '找不到可用的 Java');
    const parsed = (await loadServerProperties(row.rootPath))?.parsed ?? null;
    const free = this.deps.portFree ?? isPortFree;
    const serverPort = parsePort(propertyValue(parsed, 'server-port', '25565'), 25565);
    if (!(await free(serverPort))) throw new AppError('PORT_IN_USE', `端口 ${serverPort} 已被占用`, { port: serverPort });
    if (propertyValue(parsed, 'enable-rcon', 'false').toLowerCase() === 'true') {
      const rconPort = parsePort(propertyValue(parsed, 'rcon.port', '25575'), 25575);
      if (!(await free(rconPort))) {
        throw new AppError('PORT_IN_USE', `RCON 端口 ${rconPort} 已被占用`, { port: rconPort });
      }
    }
  }

  private async stopInternal(instanceId: string): Promise<void> {
    const row = this.getInstance(instanceId);
    const runtime = this.requireRuntime(instanceId);
    if (runtime.state === 'running') {
      this.move(instanceId, 'stop_requested', {});
      const result = await this.deps.driver.stopProcess(instanceId, row.stopTimeoutSec);
      if (result.forced) {
        this.deps.audit.record({ action: 'instance.force_stop', targetType: 'instance', targetId: instanceId });
      }
      if (this.requireRuntime(instanceId).state !== 'stopped') this.updateState(instanceId, 'stopped', { pid: null });
      this.deps.audit.record({ action: 'instance.stop', targetType: 'instance', targetId: instanceId });
      return;
    }
    if (runtime.state === 'orphaned') {
      if (!runtime.pid) throw new AppError('INVALID_STATE', '没有记录到进程 PID');
      const pid = runtime.pid;
      this.move(instanceId, 'stop_requested', {});
      try {
        await this.deps.rcon.send(row, 'stop');
      } catch {
        this.updateState(instanceId, 'unknown', { error: 'RCON 失联，无法停止服务器' });
        throw new AppError('RCON_UNAVAILABLE', 'RCON 失联，无法停止服务器');
      }
      const stopped = await waitForCondition(() => !isPidAlive(pid), ORPHAN_STOP_TIMEOUT_MS);
      if (!stopped) {
        this.updateState(instanceId, 'unknown', { error: '服务器未在 60 秒内退出' });
        throw new AppError('INVALID_STATE', '服务器未在 60 秒内退出');
      }
      this.updateState(instanceId, 'stopped', { pid: null, error: null });
      this.deps.audit.record({ action: 'instance.stop', targetType: 'instance', targetId: instanceId });
      return;
    }
    throw new AppError('INVALID_STATE', `当前状态 ${runtime.state} 不能停止`);
  }

  private handleExit(instanceId: string, code: number | null): void {
    const runtime = this.runtime.get(instanceId);
    this.aborting.delete(instanceId);
    if (!runtime || this.closing) return;
    this.clearTimers(instanceId);
    if (runtime.state === 'crashed') {
      this.updateState(instanceId, 'crashed', { pid: null });
      return;
    }
    if (runtime.state === 'stopping') {
      this.updateState(instanceId, 'stopped', { exitCode: code, pid: null });
      return;
    }
    if (runtime.state === 'starting' || runtime.state === 'running') {
      const hint = FAILURE_HINTS.find((item) =>
        this.getBuffer(instanceId)
          .snapshot()
          .slice(-200)
          .some((line) => item.pattern.test(line.text)),
      );
      this.updateState(instanceId, 'crashed', {
        exitCode: code,
        pid: null,
        error: hint?.message ?? `进程意外退出，退出码 ${code ?? 'unknown'}`,
      });
      this.deps.audit.record({
        action: 'instance.crash',
        targetType: 'instance',
        targetId: instanceId,
        detail: { exitCode: code },
      });
      return;
    }
    this.updateState(instanceId, 'stopped', { exitCode: code, pid: null });
  }

  /** Launchers such as run.bat `pause` keep the wrapper alive after Java dies. */
  private abortStartup(instanceId: string, message: string): void {
    if (this.aborting.has(instanceId)) return;
    if (this.runtime.get(instanceId)?.state !== 'starting') return;
    this.aborting.add(instanceId);
    this.deps.logger.warn({ instanceId, message }, 'fatal startup output detected; killing process tree');
    void this.deps.driver.killProcessTree(instanceId).catch((error: unknown) => {
      this.deps.logger.warn({ err: error, instanceId }, 'failed to kill after fatal startup output');
    });
  }

  private scheduleStartupChecks(row: InstanceRow): void {
    const fallback = setTimeout(() => {
      if (this.runtime.get(row.id)?.state !== 'starting') return;
      this.clearTimers(row.id);
      this.updateState(row.id, 'running', { error: '未检测到启动完成标记，已按 300 秒超时判定为运行中' });
      this.emit('notification', { level: 'warning', message: `${row.name} 未检测到启动完成标记` });
    }, STARTUP_TIMEOUT_MS);
    const poll = setInterval(() => {
      void (async () => {
        if (this.runtime.get(row.id)?.state !== 'starting') {
          this.clearTimers(row.id);
          return;
        }
        const probe = await this.deps.rcon.test(row).catch(() => null);
        if (probe?.status === 'connected') this.markRunning(row.id);
      })();
    }, STARTUP_RCON_POLL_MS);
    poll.unref();
    this.timers.set(row.id, [fallback, poll]);
  }

  private markRunning(instanceId: string): void {
    if (this.runtime.get(instanceId)?.state !== 'starting') return;
    this.clearTimers(instanceId);
    this.updateState(instanceId, 'running', { error: null });
  }

  private async recover(row: InstanceRow): Promise<void> {
    const runtime = this.requireRuntime(row.id);
    if (runtime.state === 'stopped') return;

    if (row.lastPid) {
      const pid = row.lastPid;
      if (!isPidAlive(pid)) {
        this.finishRecovery(row.id, runtime.state, 'crashed', '面板重启后进程已不存在');
        return;
      }
      const verified = await this.deps.driver.verifyPid(pid, row.rootPath).catch(() => true);
      if (!verified) {
        this.finishRecovery(row.id, runtime.state, 'crashed', 'PID 已被其他进程复用');
        return;
      }
      const probe = await this.deps.rcon.test(row).catch(() => null);
      if (probe?.status === 'connected') {
        this.updateState(row.id, 'orphaned', { pid, error: null });
        this.deps.audit.record({ action: 'instance.recover_orphan', targetType: 'instance', targetId: row.id });
        this.emit('notification', { level: 'warning', message: `${row.name} 的进程未被面板接管` });
      } else {
        this.updateState(row.id, 'unknown', { pid, error: '进程仍在运行但 RCON 不可用，请强制结束或手动确认' });
        this.emit('notification', { level: 'warning', message: `${row.name} 状态未知，需要人工确认` });
      }
      return;
    }

    if (runtime.state === 'crashed' || runtime.state === 'unknown') return;
    this.finishRecovery(row.id, runtime.state, 'crashed', '面板重启后进程记录丢失');
  }

  private finishRecovery(
    instanceId: string,
    previous: InstanceState,
    target: 'crashed' | 'stopped',
    message: string,
  ): void {
    const active = previous === 'starting' || previous === 'running' || previous === 'stopping' || previous === 'orphaned';
    if (!active) return;
    this.updateState(instanceId, target, { pid: null, error: message });
  }

  private async ensureHistory(instanceId: string): Promise<void> {
    const buffer = this.getBuffer(instanceId);
    if (buffer.size > 0) return;
    const row = this.getInstance(instanceId);
    const lines = await this.deps.driver.readLogTail(row.rootPath, row.logEncoding as LogEncoding);
    for (const text of lines.slice(-1000)) {
      buffer.append({ stream: 'stdout', level: classifyLevel(text), text });
    }
  }

  private getBuffer(instanceId: string): ConsoleBuffer {
    let buffer = this.buffers.get(instanceId);
    if (!buffer) {
      buffer = new ConsoleBuffer();
      this.buffers.set(instanceId, buffer);
    }
    return buffer;
  }

  private readRow(instanceId: string): InstanceRow | undefined {
    return this.deps.db.select().from(instances).where(eq(instances.id, instanceId)).get();
  }

  private getInstance(instanceId: string): InstanceRow {
    const row = this.readRow(instanceId);
    if (!row) throw new AppError('NOT_FOUND', '实例不存在');
    return row;
  }

  private requireRuntime(instanceId: string): RuntimeState {
    const existing = this.runtime.get(instanceId);
    if (existing) return existing;
    // Instances onboarded after boot have no init() entry; seed them from their row.
    const row = this.readRow(instanceId);
    if (!row) throw new AppError('NOT_FOUND', '实例不存在');
    const seeded: RuntimeState = {
      state: row.lastState,
      pid: row.lastPid,
      startedAt: row.lastStartedAt,
      exitCode: row.lastExitCode,
      error: row.lastError,
    };
    this.runtime.set(instanceId, seeded);
    return seeded;
  }

  private move(instanceId: string, action: InstanceAction, patch: Partial<RuntimeState>): void {
    const current = this.requireRuntime(instanceId);
    const next = transition(current.state, action);
    if (!next) throw new AppError('INVALID_STATE', `当前状态 ${current.state} 不允许该操作`);
    this.updateState(instanceId, next, patch);
  }

  private updateState(instanceId: string, next: InstanceState, patch: Partial<RuntimeState>): void {
    const updated = { ...this.requireRuntime(instanceId), ...patch, state: next };
    this.runtime.set(instanceId, updated);
    this.deps.db
      .update(instances)
      .set({
        lastState: next,
        lastPid: updated.pid,
        lastStartedAt: updated.startedAt,
        lastExitCode: updated.exitCode,
        lastError: updated.error,
        updatedAt: Date.now(),
      })
      .where(eq(instances.id, instanceId))
      .run();
    this.emit('state', this.getStatus(instanceId));
  }

  private clearTimers(instanceId: string): void {
    for (const timer of this.timers.get(instanceId) ?? []) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers.delete(instanceId);
  }

  isBusy(instanceId: string): boolean {
    return this.locks.has(instanceId);
  }

  runExclusive<T>(instanceId: string, task: () => Promise<T>): Promise<T> {
    return this.withLock(instanceId, task);
  }

  /** Boot-time override used by restore recovery; bypasses the state machine on purpose. */
  forceRecoveryUnknown(instanceId: string, error: string): void {
    this.updateState(instanceId, 'unknown', { error });
  }

  private async withLock<T>(instanceId: string, task: () => Promise<T>): Promise<T> {
    if (this.locks.has(instanceId)) throw new AppError('OPERATION_IN_PROGRESS', '实例已有操作在执行');
    this.locks.add(instanceId);
    try {
      return await task();
    } finally {
      this.locks.delete(instanceId);
    }
  }

  private checkCommandRate(instanceId: string): void {
    const now = Date.now();
    const recent = (this.commandTimes.get(instanceId) ?? []).filter((time) => now - time < 60_000);
    if (recent.length >= COMMAND_LIMIT_PER_MINUTE) {
      throw new AppError('COMMAND_RATE_LIMITED', '命令发送过快，请稍后再试');
    }
    recent.push(now);
    this.commandTimes.set(instanceId, recent);
  }
}

async function waitForCondition(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return predicate();
}
