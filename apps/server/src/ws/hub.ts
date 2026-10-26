import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import {
  SESSION_COOKIE,
  WS_CHANNEL_PATTERN,
  wsClientMessageSchema,
  type ConsoleLine,
  type InstanceStatusSnapshot,
  type ServerWsMessage,
} from '@mcpanel/shared';
import { isSameAuthority } from '../auth/guard';
import type { SessionService } from '../auth/session';
import type { DB } from '../db/client';
import { instances } from '../db/schema';
import type { InstanceSupervisor } from '../services/instance-supervisor';
import type { MetricsService } from '../services/metrics-service';
import type { TaskTracker } from '../services/task-tracker';
import { AppError } from '../utils/errors';

const MAX_BUFFERED_BYTES = 1024 * 1024;
const IDLE_TIMEOUT_MS = 70_000;
const SWEEP_INTERVAL_MS = 30_000;
const CONSOLE_BATCH_MS = 60;

interface ClientConn {
  socket: WebSocket;
  subscriptions: Set<string>;
  lastSeen: number;
  dropped: Map<string, number>;
}

export interface WsHubDeps {
  db: DB;
  sessions: SessionService;
  supervisor: InstanceSupervisor;
  metrics: MetricsService;
  tasks: TaskTracker;
  logger?: FastifyBaseLogger;
}

export class WsHub {
  private readonly clients = new Map<WebSocket, ClientConn>();
  private readonly consolePending = new Map<string, ConsoleLine[]>();
  private sweeper: NodeJS.Timeout | null = null;
  private consoleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: WsHubDeps) {
    deps.supervisor.on('console', (instanceId: string, lines: ConsoleLine[]) => this.publishConsole(instanceId, lines));
    deps.supervisor.on('state', (snapshot: InstanceStatusSnapshot) => this.publishState(snapshot));
    deps.supervisor.on('notification', (notification: { level: string; message: string }) =>
      this.publishNotification(notification),
    );
    deps.metrics.setSink((message) => this.publishMetrics(message));
    deps.tasks.setSink((task) => this.publishTask(task));
  }

  register(app: FastifyInstance): void {
    this.sweeper = setInterval(() => this.sweepIdle(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();

    app.get(
      '/api/ws',
      {
        websocket: true,
        preValidation: [
          async (request: FastifyRequest) => {
            const origin = request.headers.origin ?? '';
            if (!isSameAuthority(origin, request.headers.host ?? '')) {
              throw new AppError('FORBIDDEN', '来源校验失败');
            }
            const token = request.cookies[SESSION_COOKIE];
            const resolved = token ? this.deps.sessions.resolve(token) : null;
            if (!resolved) throw new AppError('AUTH_REQUIRED', '请先登录');
            request.user = resolved.user;
            request.sessionToken = token ?? null;
          },
        ],
      },
      (socket: WebSocket) => this.attach(socket),
    );
  }

  publishConsole(instanceId: string, lines: ConsoleLine[]): void {
    const channel = `instance:${instanceId}:console`;
    const pending = this.consolePending.get(channel);
    if (pending) pending.push(...lines);
    else this.consolePending.set(channel, [...lines]);
    if (this.consoleTimer) return;
    this.consoleTimer = setTimeout(() => this.flushConsole(), CONSOLE_BATCH_MS);
    this.consoleTimer.unref();
  }

  publishState(snapshot: InstanceStatusSnapshot): void {
    const channel = `instance:${snapshot.instanceId}:status`;
    for (const conn of this.clients.values()) {
      if (!conn.subscriptions.has(channel)) continue;
      this.send(conn, {
        type: 'instance.state',
        instanceId: snapshot.instanceId,
        state: snapshot.state,
        pid: snapshot.pid,
        startedAt: snapshot.startedAt,
        error: snapshot.error,
      });
    }
  }

  publishMetrics(message: ServerWsMessage): void {
    if (message.type !== 'metrics.sample') return;
    const channel = message.target === 'system' ? 'system:metrics' : `instance:${message.instanceId}:metrics`;
    for (const conn of this.clients.values()) {
      if (conn.subscriptions.has(channel)) this.send(conn, message);
    }
  }

  publishNotification(notification: { level: string; message: string }): void {
    const level = notification.level === 'error' ? 'error' : notification.level === 'info' ? 'info' : 'warning';
    const message: ServerWsMessage = { type: 'notification', level, message: notification.message };
    for (const conn of this.clients.values()) this.send(conn, message);
  }

  closeAll(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    if (this.consoleTimer) clearTimeout(this.consoleTimer);
    this.consoleTimer = null;
    this.consolePending.clear();
    for (const conn of this.clients.values()) {
      conn.socket.close();
      this.releaseAll(conn);
    }
    this.clients.clear();
  }

  get connectionCount(): number {
    return this.clients.size;
  }

  publishTask(task: import('@mcpanel/shared').TaskInfo): void {
    const channel = `task:${task.id}`;
    for (const conn of this.clients.values()) {
      if (!conn.subscriptions.has(channel)) continue;
      this.send(conn, { type: 'task.update', task });
    }
  }

  private attach(socket: WebSocket): void {
    const conn: ClientConn = { socket, subscriptions: new Set(), lastSeen: Date.now(), dropped: new Map() };
    this.clients.set(socket, conn);
    this.send(conn, { type: 'hello', channels: [], serverTime: new Date().toISOString() });
    socket.on('message', (raw: Buffer) => {
      conn.lastSeen = Date.now();
      this.handle(conn, raw.toString()).catch((error: unknown) => {
        // A rejection here would reach the process-level unhandledRejection
        // handler and shut the whole panel down; contain it per client instead.
        this.deps.logger?.warn({ err: error }, 'ws message handling failed');
        this.send(conn, { type: 'error', code: 'INTERNAL', message: '消息处理失败' });
      });
    });
    socket.on('close', () => this.cleanup(conn));
    socket.on('error', () => this.cleanup(conn));
  }

  private async handle(conn: ClientConn, raw: string): Promise<void> {
    let message: ReturnType<typeof wsClientMessageSchema.parse>;
    try {
      message = wsClientMessageSchema.parse(JSON.parse(raw));
    } catch {
      this.send(conn, { type: 'error', code: 'VALIDATION_ERROR', message: '消息格式错误' });
      return;
    }
    if (message.type === 'ping') {
      this.send(conn, { type: 'pong' });
      return;
    }
    if (!WS_CHANNEL_PATTERN.test(message.channel)) {
      this.send(conn, { type: 'error', code: 'FORBIDDEN', message: '未知频道' });
      return;
    }
    if (message.type === 'unsubscribe') {
      if (conn.subscriptions.delete(message.channel)) this.releaseChannel(message.channel);
      return;
    }
    if (conn.subscriptions.has(message.channel)) {
      // The instance may have been deleted since the first subscribe (deletion
      // does not notify the hub); re-check so sendInitial cannot throw NOT_FOUND.
      if (this.ensureInstanceExists(conn, message.channel)) {
        await this.sendInitial(conn, message.channel, message.sinceSeq);
      }
      return;
    }
    const parts = message.channel.split(':');
    if (parts[0] === 'instance') {
      const instanceId = parts[1]!;
      const exists = this.deps.db.select({ id: instances.id }).from(instances).where(eq(instances.id, instanceId)).get();
      if (!exists) {
        this.send(conn, { type: 'error', code: 'NOT_FOUND', message: '实例不存在' });
        return;
      }
      if (parts[2] === 'players') {
        this.send(conn, { type: 'error', code: 'FORBIDDEN', message: '玩家频道将在阶段 2 提供' });
        return;
      }
    }
    if (parts[0] === 'task') {
      const task = this.deps.tasks.get(parts[1]!);
      if (!task) {
        this.send(conn, { type: 'error', code: 'NOT_FOUND', message: '任务不存在或已过期' });
        return;
      }
      conn.subscriptions.add(message.channel);
      this.send(conn, { type: 'task.update', task });
      return;
    }
    conn.subscriptions.add(message.channel);
    if (message.channel === 'system:metrics') this.deps.metrics.setSystemActive(true);
    else if (parts[0] === 'instance' && parts[2] === 'metrics') this.deps.metrics.setInstanceActive(parts[1]!, true);
    await this.sendInitial(conn, message.channel, message.sinceSeq);
  }

  private async sendInitial(conn: ClientConn, channel: string, sinceSeq?: number): Promise<void> {
    if (channel.startsWith('task:')) {
      const task = this.deps.tasks.get(channel.slice(5));
      if (task) this.send(conn, { type: 'task.update', task });
      return;
    }
    if (channel === 'system:metrics') {
      const latest = this.deps.metrics.getLatestSystem();
      if (latest) this.send(conn, { type: 'metrics.sample', target: 'system', ts: latest.ts, sample: latest });
      return;
    }
    const [kind, instanceId, kindName] = channel.split(':');
    if (kind !== 'instance' || !instanceId) return;
    if (kindName === 'console') {
      const snapshot = await this.deps.supervisor.getConsoleSnapshot(instanceId, sinceSeq);
      if (snapshot.mode === 'append') {
        this.send(conn, { type: 'console.append', channel, lines: snapshot.lines });
      } else {
        this.send(conn, {
          type: 'console.snapshot',
          channel,
          lines: snapshot.lines,
          lastSeq: snapshot.lines.at(-1)?.seq ?? 0,
          gap: snapshot.gap,
        });
      }
      return;
    }
    if (kindName === 'status') {
      const status = this.deps.supervisor.getStatus(instanceId);
      this.send(conn, {
        type: 'instance.state',
        instanceId,
        state: status.state,
        pid: status.pid,
        startedAt: status.startedAt,
        error: status.error,
      });
      return;
    }
    if (kindName === 'metrics') {
      const latest = this.deps.metrics.getLatestInstance(instanceId);
      if (latest) {
        this.send(conn, { type: 'metrics.sample', target: 'instance', instanceId, ts: latest.ts, sample: latest });
      }
    }
  }

  /** Only for channels with an active subscription: drops it when the instance is gone. */
  private ensureInstanceExists(conn: ClientConn, channel: string): boolean {
    const [kind, instanceId] = channel.split(':');
    if (kind !== 'instance' || !instanceId) return true;
    const exists = this.deps.db.select({ id: instances.id }).from(instances).where(eq(instances.id, instanceId)).get();
    if (exists) return true;
    conn.subscriptions.delete(channel);
    this.releaseChannel(channel);
    this.send(conn, { type: 'error', code: 'NOT_FOUND', message: '实例不存在' });
    return false;
  }

  private releaseChannel(channel: string): void {
    if (channel === 'system:metrics') {
      this.deps.metrics.setSystemActive(false);
      return;
    }
    const [kind, instanceId, kindName] = channel.split(':');
    if (kind === 'instance' && instanceId && kindName === 'metrics') this.deps.metrics.setInstanceActive(instanceId, false);
  }

  private releaseAll(conn: ClientConn): void {
    for (const channel of conn.subscriptions) this.releaseChannel(channel);
    conn.subscriptions.clear();
  }

  private cleanup(conn: ClientConn): void {
    if (!this.clients.has(conn.socket)) return;
    this.clients.delete(conn.socket);
    this.releaseAll(conn);
    conn.socket.removeAllListeners();
  }

  private flushConsole(): void {
    this.consoleTimer = null;
    const pending = [...this.consolePending.entries()];
    this.consolePending.clear();
    for (const [channel, lines] of pending) {
      for (const conn of this.clients.values()) {
        if (!conn.subscriptions.has(channel)) continue;
        if (conn.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
          conn.dropped.set(channel, (conn.dropped.get(channel) ?? 0) + lines.length);
          continue;
        }
        const dropped = conn.dropped.get(channel) ?? 0;
        if (dropped > 0) {
          this.send(conn, { type: 'console.gap', channel, dropped });
          conn.dropped.delete(channel);
        }
        this.send(conn, { type: 'console.append', channel, lines });
      }
    }
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (const conn of [...this.clients.values()]) {
      if (now - conn.lastSeen > IDLE_TIMEOUT_MS) {
        conn.socket.close(1000, 'idle');
        this.cleanup(conn);
      }
    }
  }

  private send(conn: ClientConn, message: ServerWsMessage): void {
    if (conn.socket.readyState !== WebSocket.OPEN) return;
    conn.socket.send(JSON.stringify(message));
  }
}
