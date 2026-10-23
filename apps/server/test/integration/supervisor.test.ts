import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConsoleLine, InstanceStatusSnapshot } from '@mcpanel/shared';
import { instances } from '../../src/db/schema';
import { silentLogger } from '../../src/logger';
import { LocalNodeDriver } from '../../src/nodes/local-driver';
import { PathSandbox } from '../../src/nodes/path-sandbox';
import { killPidTree, spawnServer } from '../../src/nodes/process-tree';
import { AuditService } from '../../src/services/audit-service';
import { InstanceSupervisor } from '../../src/services/instance-supervisor';
import { RconService } from '../../src/services/rcon-service';
import { createTestDb, type TestDb } from '../helpers/db';
import { insertInstanceRow } from '../helpers/factory';
import { startFakeRcon } from '../fixtures/fake-rcon.mjs';

const fixture = fileURLToPath(new URL('../fixtures/fake-server.mjs', import.meta.url));

let ctx: TestDb | undefined;
let root: string;
let supervisor: InstanceSupervisor | undefined;
let externalChild: ReturnType<typeof spawnServer> | undefined;
let externalRconClose: (() => Promise<void>) | undefined;

async function prepare(name: string, overrides: Record<string, unknown> = {}) {
  ctx = createTestDb();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-supervisor-'));
  await fs.writeFile(path.join(root, 'eula.txt'), 'eula=true\n');
  const instance = insertInstanceRow(ctx.db, {
    name,
    rootPath: root,
    startCommand: `"${process.execPath}" "${fixture}" --root "${root}"`,
    stopTimeoutSec: 10,
    ...overrides,
  });
  const driver = new LocalNodeDriver(new PathSandbox(ctx.dir));
  supervisor = new InstanceSupervisor({
    db: ctx.db,
    driver,
    rcon: new RconService(),
    audit: new AuditService(ctx.db, silentLogger()),
    logger: silentLogger(),
    dataDir: ctx.dir,
    detectJava: async () => ({ path: 'java', major: 21 }),
    portFree: async () => true,
  });
  await supervisor.init();
  return { instance, driver, supervisor };
}

afterEach(async () => {
  await supervisor?.shutdown();
  supervisor = undefined;
  if (externalChild?.pid) {
    const exited = new Promise<void>((resolve) => externalChild!.once('exit', () => resolve()));
    await killPidTree(externalChild.pid).catch(() => undefined);
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
  externalChild = undefined;
  await externalRconClose?.();
  externalRconClose = undefined;
  ctx?.close();
  ctx = undefined;
  if (root) await rmWithRetry(root);
});

// Windows keeps a directory locked while a child process still uses it as cwd.
async function rmWithRetry(target: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('InstanceSupervisor', () => {
  it('starts, reaches running, records history, accepts commands and stops', async () => {
    const { instance, supervisor: service } = await prepare('生存服');
    const lines: ConsoleLine[] = [];
    const states: InstanceStatusSnapshot[] = [];
    service.on('console', (_id: string, entries: ConsoleLine[]) => lines.push(...entries));
    service.on('state', (snapshot: InstanceStatusSnapshot) => states.push(snapshot));

    const started = await service.start(instance.id);
    expect(started.state).toBe('starting');
    await waitFor(() => service.getStatus(instance.id).state === 'running');
    await waitFor(() => lines.some((line) => line.text.includes('Done (')));
    expect(lines[0]?.seq).toBe(1);

    await service.sendCommand(instance.id, 'say hello');
    await waitFor(() => lines.some((line) => line.text.includes('received say hello')));

    await service.stop(instance.id);
    expect(service.getStatus(instance.id).state).toBe('stopped');
    const transitions = states.map((state) => state.state).filter((value, index, all) => value !== all[index - 1]);
    expect(transitions).toEqual(['starting', 'running', 'stopping', 'stopped']);

    const stored = ctx!.db.select().from(instances).where(eq(instances.id, instance.id)).get();
    expect(stored?.lastState).toBe('stopped');
    expect(stored?.lastPid).toBeNull();
  }, 40000);

  it('starts an instance onboarded after init() without a panel restart', async () => {
    await prepare('首个实例');
    const service = supervisor!;

    const lateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-supervisor-'));
    await fs.writeFile(path.join(lateRoot, 'eula.txt'), 'eula=true\n');
    const late = insertInstanceRow(ctx!.db, {
      name: '后纳管服',
      rootPath: lateRoot,
      startCommand: `"${process.execPath}" "${fixture}" --root "${lateRoot}"`,
      stopTimeoutSec: 10,
    });

    const started = await service.start(late.id);
    expect(started.state).toBe('starting');
    await waitFor(() => service.getStatus(late.id).state === 'running');
    await service.stop(late.id);
    expect(service.getStatus(late.id).state).toBe('stopped');

    service.forget(late.id);
    expect(() => service.getStatus(late.id)).not.toThrow();
    await rmWithRetry(lateRoot);
  }, 60000);

  it('rejects start while running and stop while stopped', async () => {
    const { instance, supervisor: service } = await prepare('状态检查');
    await service.start(instance.id);
    await waitFor(() => service.getStatus(instance.id).state === 'running');
    await expect(service.start(instance.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await service.stop(instance.id);
    await expect(service.stop(instance.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  }, 40000);

  it('restarts a stopped instance and reports a crash with a readable hint', async () => {
    const { instance, supervisor: service } = await prepare('崩溃服');
    ctx!.db.update(instances)
      .set({ startCommand: `"${process.execPath}" "${fixture}" --root "${root}" --crash` })
      .where(eq(instances.id, instance.id))
      .run();

    await service.start(instance.id);
    await waitFor(() => service.getStatus(instance.id).state === 'crashed', 8000);
    const status = service.getStatus(instance.id);
    expect(status.exitCode).toBe(1);
    expect(status.error).toContain('eula');
  }, 40000);

  it('recovers a missing process as crashed and a live one with RCON as orphaned', async () => {
    ctx = createTestDb();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-recovery-'));
    const ghostRoot = path.join(root, 'ghost');
    const orphanRoot = path.join(root, 'orphan');
    await fs.mkdir(ghostRoot);
    await fs.mkdir(orphanRoot);
    await fs.writeFile(path.join(orphanRoot, 'eula.txt'), 'eula=true\n');

    insertInstanceRow(ctx.db, { name: 'ghost', rootPath: ghostRoot, lastState: 'running', lastPid: 999_999 });
    const fake = await startFakeRcon({ password: 'secret' });
    externalRconClose = fake.close;
    await fs.writeFile(
      path.join(orphanRoot, 'server.properties'),
      `enable-rcon=true\nrcon.port=${fake.port}\nrcon.password=secret\n`,
    );

    externalChild = spawnServer(orphanRoot, `"${process.execPath}" "${fixture}" --root "${orphanRoot}" --exit-after=60000`);
    await new Promise((resolve) => externalChild!.once('spawn', resolve));
    const orphan = insertInstanceRow(ctx.db, {
      name: 'orphan',
      rootPath: orphanRoot,
      lastState: 'running',
      lastPid: externalChild.pid,
    });

    const driver = new LocalNodeDriver(new PathSandbox(ctx.dir));
    const service = new InstanceSupervisor({
      db: ctx.db,
      driver,
      rcon: new RconService(),
      audit: new AuditService(ctx.db, silentLogger()),
      logger: silentLogger(),
      dataDir: ctx.dir,
    });
    supervisor = service;
    await service.init();

    expect(service.getStatus(orphan.id).state).toBe('orphaned');
    expect(service.getStatus(orphan.id).pid).toBe(externalChild.pid);
    expect(driver.getProcessSnapshot(orphan.id)).toBeNull();
    const recovered = ctx.db.select().from(instances).where(eq(instances.id, orphan.id)).get();
    expect(recovered?.lastState).toBe('orphaned');

    const ghostRows = ctx.db.select().from(instances).all();
    const ghost = ghostRows.find((row) => row.name === 'ghost')!;
    expect(service.getStatus(ghost.id).state).toBe('crashed');
    expect(service.getStatus(ghost.id).error).toContain('进程已不存在');
  }, 40000);

  it('markStopped only works for unknown/crashed with a dead pid', async () => {
    const { instance, supervisor: service } = await prepare('标记停止');
    ctx!.db.update(instances).set({ lastState: 'crashed', lastPid: 999_998 }).where(eq(instances.id, instance.id)).run();
    await service.init();
    expect(service.getStatus(instance.id).state).toBe('crashed');
    await service.markStopped(instance.id);
    expect(service.getStatus(instance.id).state).toBe('stopped');
    await expect(service.markStopped(instance.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  }, 40000);

  it('rate limits console commands per instance', async () => {
    const { instance, supervisor: service } = await prepare('限流');
    await service.start(instance.id);
    await waitFor(() => service.getStatus(instance.id).state === 'running');
    for (let index = 0; index < 30; index += 1) await service.sendCommand(instance.id, `say ${index}`);
    await expect(service.sendCommand(instance.id, 'say too-fast')).rejects.toMatchObject({
      code: 'COMMAND_RATE_LIMITED',
    });
    await service.stop(instance.id);
  }, 60000);

  it('seeds console history from logs/latest.log when the buffer is empty', async () => {
    const { instance, supervisor: service } = await prepare('历史');
    await fs.mkdir(path.join(root, 'logs'), { recursive: true });
    await fs.writeFile(path.join(root, 'logs', 'latest.log'), 'line one\nline two\n');
    const snapshot = await service.getConsoleSnapshot(instance.id);
    expect(snapshot.mode).toBe('snapshot');
    expect(snapshot.lines.map((line) => line.text)).toEqual(['line one', 'line two']);
    expect(await service.getRecentLines(instance.id, 1)).toHaveLength(1);
  }, 20000);
});
