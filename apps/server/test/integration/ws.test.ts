import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { ConsoleLine } from '@mcpanel/shared';
import { buildApp } from '../../src/app';
import { SessionService } from '../../src/auth/session';
import { LoginThrottle } from '../../src/auth/guard';
import { loadConfig } from '../../src/config';
import { instances } from '../../src/db/schema';
import { silentLogger } from '../../src/logger';
import { LocalNodeDriver } from '../../src/nodes/local-driver';
import { PathSandbox } from '../../src/nodes/path-sandbox';
import { AuditService } from '../../src/services/audit-service';
import { InstanceService } from '../../src/services/instance-service';
import { insertInstanceRow, insertUser } from '../helpers/factory';
import { MetricsService } from '../../src/services/metrics-service';
import { TaskTracker } from '../../src/services/task-tracker';
import { ProbeService } from '../../src/services/probe-service';
import { RconService } from '../../src/services/rcon-service';
import type { InstanceSupervisor } from '../../src/services/instance-supervisor';
import { createTestDb, type TestDb } from '../helpers/db';
import { CookieJar, json } from '../helpers/http';

let ctx: TestDb | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
const sockets: WebSocket[] = [];

async function makeApp() {
  ctx = createTestDb();
  const instance = insertInstanceRow(ctx.db, { name: 'ws' });
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: ctx.dir });
  const sessions = new SessionService(ctx.db);
  const { token } = sessions.create(insertUser(ctx.db), null, null);
  const supervisor = Object.assign(new EventEmitter(), {
    getStatus: () => ({
      instanceId: instance.id,
      state: 'running',
      pid: 4242,
      startedAt: new Date(0).toISOString(),
      exitCode: null,
      error: null,
    }),
    getConsoleSnapshot: async (_id: string, sinceSeq?: number) =>
      sinceSeq === undefined
        ? { mode: 'snapshot', lines: [], gap: false }
        : { mode: 'append', lines: [] },
  }) as unknown as InstanceSupervisor;
  const metrics = new MetricsService({
    collector: {
      system: async () => ({
        ts: new Date().toISOString(),
        cpuPercent: 1,
        memUsedBytes: 2,
        memTotalBytes: 3,
        diskFreeBytes: 4,
        diskTotalBytes: 5,
        uptimeSec: 6,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        panelVersion: '0.1.0',
      }),
      instance: async () => ({ ts: new Date().toISOString(), cpu: 1, memBytes: 2, diskFreeBytes: 3 }),
    },
    supervisor,
    db: ctx.db,
    dataDir: ctx.dir,
  });
  const tasks = new TaskTracker();
  const sandbox = new PathSandbox(ctx.dir);
  app = await buildApp(
    config,
    ctx.db,
    {
      sessions,
      audit: new AuditService(ctx.db),
      loginThrottle: new LoginThrottle(),
      supervisor,
      metrics,
      rcon: new RconService(),
      driver: new LocalNodeDriver(sandbox),
      probe: new ProbeService(sandbox, async () => null),
      instances: new InstanceService(ctx.db, ctx.dir),
      tasks,
    },
    { logger: silentLogger() },
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  return { app, instance, supervisor, metrics, tasks, token, url: `ws://127.0.0.1:${address.port}/api/ws`, httpOrigin: `http://127.0.0.1:${address.port}` };
}

function connect(url: string, headers: Record<string, string>): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    sockets.push(socket);
    const testSocket = new TestSocket(socket);
    socket.once('error', reject);
    socket.once('open', () => resolve(testSocket));
  });
}

/** Buffers frames from the moment the socket exists so early messages are never lost. */
class TestSocket {
  private readonly queue: Record<string, unknown>[] = [];
  private readonly waiters: Array<(message: Record<string, unknown>) => void> = [];

  constructor(private readonly socket: WebSocket) {
    this.socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
  }

  send(payload: unknown): void {
    this.socket.send(JSON.stringify(payload));
  }

  next(timeoutMs = 5000): Promise<Record<string, unknown>> {
    const buffered = this.queue.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      const waiter = (message: Record<string, unknown>): void => {
        clearTimeout(timer);
        resolve(message);
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('timed out waiting for a ws message'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  nextOrNothing(waitMs: number): Promise<Record<string, unknown> | undefined> {
    return this.next(waitMs).catch(() => undefined);
  }

  /** Reads frames until one of the wanted type shows up, ignoring unrelated pushes. */
  async nextOfType(type: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`no "${type}" frame before the deadline`);
      const message = await this.next(remaining);
      if (message.type === type) return message;
    }
  }

  close(): void {
    this.socket.close();
  }
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await app?.close();
  app = undefined;
  ctx?.close();
  ctx = undefined;
});

describe('WebSocket hub', () => {
  it('authenticates, replays console, streams state and honours subscriptions', { timeout: 20000 }, async () => {
    const { instance, supervisor, token, url, httpOrigin } = await makeApp();
    const socket = await connect(url, { cookie: `mcpanel_session=${token}`, origin: httpOrigin });
    expect((await socket.next()).type).toBe('hello');

    socket.send({ type: 'subscribe', channel: `instance:${instance.id}:console` });
    expect(await socket.next()).toMatchObject({
      type: 'console.snapshot',
      channel: `instance:${instance.id}:console`,
    });

    const line: ConsoleLine = { seq: 1, ts: new Date().toISOString(), stream: 'stdout', level: 'info', text: 'hello' };
    supervisor.emit('console', instance.id, [line]);
    expect(await socket.next()).toMatchObject({ type: 'console.append', lines: [line] });

    socket.send({ type: 'subscribe', channel: `instance:${instance.id}:status` });
    expect(await socket.next()).toMatchObject({ type: 'instance.state', state: 'running', pid: 4242 });

    supervisor.emit('state', supervisor.getStatus(instance.id));
    expect(await socket.next()).toMatchObject({ type: 'instance.state', pid: 4242 });

    socket.send({ type: 'ping' });
    expect(await socket.next()).toMatchObject({ type: 'pong' });

    socket.send({ type: 'subscribe', channel: 'system:metrics' });
    expect(await socket.next()).toMatchObject({ type: 'metrics.sample', target: 'system' });

    socket.send({ type: 'unsubscribe', channel: `instance:${instance.id}:console` });
    // Give the server a chance to process the unsubscribe before publishing again.
    await new Promise((resolve) => setTimeout(resolve, 150));
    supervisor.emit('console', instance.id, [line]);
    const frames: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const frame = await socket.nextOrNothing(250);
      if (!frame) break;
      frames.push(String(frame.type));
    }
    expect(frames).not.toContain('console.append');

    supervisor.emit('notification', { level: 'warning', message: '实例进入 orphaned 状态' });
    expect(await socket.nextOfType('notification')).toMatchObject({ type: 'notification', level: 'warning' });
  });

  it('batches console lines emitted in the same window', { timeout: 20000 }, async () => {
    const { instance, supervisor, token, url, httpOrigin } = await makeApp();
    const socket = await connect(url, { cookie: `mcpanel_session=${token}`, origin: httpOrigin });
    await socket.next();

    socket.send({ type: 'subscribe', channel: `instance:${instance.id}:console` });
    expect(await socket.next()).toMatchObject({ type: 'console.snapshot' });

    const first: ConsoleLine = { seq: 1, ts: new Date().toISOString(), stream: 'stdout', level: 'info', text: 'one' };
    const second: ConsoleLine = { seq: 2, ts: new Date().toISOString(), stream: 'stdout', level: 'info', text: 'two' };
    supervisor.emit('console', instance.id, [first]);
    supervisor.emit('console', instance.id, [second]);

    const frame = await socket.nextOfType('console.append');
    expect(frame.lines).toEqual([first, second]);
    await expect(socket.nextOrNothing(200)).resolves.toBeUndefined();
  });

  it('rejects unknown channels, missing instances and unauthenticated sockets', async () => {
    const { instance, token, url, httpOrigin } = await makeApp();
    const socket = await connect(url, { cookie: `mcpanel_session=${token}`, origin: httpOrigin });
    await socket.next();

    socket.send({ type: 'subscribe', channel: 'nonsense' });
    expect(await socket.next()).toMatchObject({ type: 'error', code: 'FORBIDDEN' });

    socket.send({ type: 'subscribe', channel: 'instance:00000000-0000-4000-8000-000000000000:console' });
    expect(await socket.next()).toMatchObject({ type: 'error', code: 'NOT_FOUND' });

    socket.send({ type: 'subscribe', channel: `instance:${instance.id}:players` });
    expect(await socket.next()).toMatchObject({ type: 'error', code: 'FORBIDDEN' });

    socket.send('not json');
    expect(await socket.next()).toMatchObject({ type: 'error', code: 'VALIDATION_ERROR' });

    await expect(connect(url, { origin: httpOrigin })).rejects.toThrow(/Unexpected /);
    await expect(connect(url, { cookie: `mcpanel_session=${token}`, origin: 'http://evil.example' })).rejects.toThrow();
  });

  // Regression: instance deletion does not notify the hub, so a re-subscribe on
  // a stale channel used to throw NOT_FOUND out of handle() and hit the
  // process-level unhandledRejection fatal handler, shutting the panel down.
  it('answers NOT_FOUND when re-subscribing to a deleted instance and keeps serving', async () => {
    const { instance, token, url, httpOrigin } = await makeApp();
    const socket = await connect(url, { cookie: `mcpanel_session=${token}`, origin: httpOrigin });
    await socket.next();

    const channel = `instance:${instance.id}:console`;
    socket.send({ type: 'subscribe', channel });
    expect(await socket.next()).toMatchObject({ type: 'console.snapshot', channel });

    ctx!.db.delete(instances).where(eq(instances.id, instance.id)).run();

    socket.send({ type: 'subscribe', channel });
    expect(await socket.next()).toMatchObject({ type: 'error', code: 'NOT_FOUND' });

    // The stale subscription is dropped; the connection itself stays usable.
    socket.send({ type: 'subscribe', channel });
    expect(await socket.next()).toMatchObject({ type: 'error', code: 'NOT_FOUND' });
    socket.send({ type: 'ping' });
    expect(await socket.next()).toMatchObject({ type: 'pong' });
  });

  it('activates metrics sampling while a metrics channel is subscribed', async () => {
    const { instance, metrics, token, url, httpOrigin } = await makeApp();
    const spy = vi.spyOn(metrics, 'setInstanceActive');
    const systemSpy = vi.spyOn(metrics, 'setSystemActive');
    const socket = await connect(url, { cookie: `mcpanel_session=${token}`, origin: httpOrigin });
    await socket.next();

    socket.send({ type: 'subscribe', channel: `instance:${instance.id}:metrics` });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(spy).toHaveBeenCalledWith(instance.id, true);
    socket.send({ type: 'unsubscribe', channel: `instance:${instance.id}:metrics` });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(spy).toHaveBeenCalledWith(instance.id, false);
    expect(systemSpy).not.toHaveBeenCalled();
    socket.close();
  });

  it('keeps the system overview endpoint authenticated', async () => {
    const { app: server, token, httpOrigin } = await makeApp();
    const jar = new CookieJar();
    jar.set('mcpanel_session', token);
    const anonymous = await server.inject({ method: 'GET', url: '/api/system/overview' });
    expect(anonymous.statusCode).toBe(401);
    const ok = await server.inject({ method: 'GET', url: '/api/system/overview', headers: { cookie: jar.header() } });
    expect(ok.statusCode).toBe(200);
    expect(json<{ cpuPercent: number }>(ok).cpuPercent).toBe(1);
    expect(httpOrigin).toContain('127.0.0.1');
  });

  it('streams task updates to subscribers and rejects unknown tasks', { timeout: 20000 }, async () => {
    const { tasks, token, url, httpOrigin } = await makeApp();
    const headers = { cookie: `mcpanel_session=${token}`, origin: httpOrigin };
    const socket = await connect(url, headers);

    socket.send({ type: 'subscribe', channel: `task:${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}` });
    expect(await socket.nextOfType('error')).toMatchObject({ code: 'NOT_FOUND' });

    const task = tasks.start('backup', 'instance-1');
    socket.send({ type: 'subscribe', channel: `task:${task.id}` });
    await expect(socket.nextOfType('task.update')).resolves.toMatchObject({ task: { id: task.id, status: 'running' } });

    tasks.finish(task.id, 'success', '备份完成');
    await expect(socket.nextOfType('task.update')).resolves.toMatchObject({ task: { id: task.id, status: 'success' } });
  });
});
