import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerWsMessage, SystemMetricsSample } from '@mcpanel/shared';
import { collectTreePids, MetricsService, type MetricsCollector } from '../../src/services/metrics-service';
import { diskUsage } from '../../src/utils/disk';
import { instances } from '../../src/db/schema';
import type { InstanceSupervisor } from '../../src/services/instance-supervisor';
import { createTestDb, type TestDb } from '../helpers/db';
import { insertInstanceRow } from '../helpers/factory';

const contexts: TestDb[] = [];
const dirs: string[] = [];

function systemSample(cpuPercent = 10): SystemMetricsSample {
  return {
    ts: new Date().toISOString(),
    cpuPercent,
    memUsedBytes: 100,
    memTotalBytes: 200,
    diskFreeBytes: 300,
    diskTotalBytes: 400,
    uptimeSec: 50,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    panelVersion: '0.1.0',
  };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const ctx of contexts.splice(0)) ctx.close();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('MetricsService', () => {
  it('samples system and instance metrics only while subscribed', async () => {
    vi.useFakeTimers();
    const ctx = createTestDb();
    contexts.push(ctx);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-metrics-'));
    dirs.push(root);
    const instance = insertInstanceRow(ctx.db, { name: 'metrics', rootPath: root });

    const collector: MetricsCollector = {
      system: async () => systemSample(),
      instance: async () => ({ ts: new Date().toISOString(), cpu: 5, memBytes: 1000, diskFreeBytes: 300 }),
    };
    const supervisor = {
      getStatus: () => ({
        instanceId: instance.id,
        state: 'running',
        pid: 123,
        startedAt: null,
        exitCode: null,
        error: null,
      }),
    } as unknown as InstanceSupervisor;

    const service = new MetricsService({ collector, supervisor, db: ctx.db, dataDir: ctx.dir });
    const messages: ServerWsMessage[] = [];
    service.setSink((message) => messages.push(message));

    service.setSystemActive(true);
    service.setInstanceActive(instance.id, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(messages.some((message) => message.type === 'metrics.sample' && message.target === 'system')).toBe(true);
    expect(messages.some((message) => message.type === 'metrics.sample' && message.target === 'instance')).toBe(true);

    await vi.advanceTimersByTimeAsync(9000);
    expect(service.getLatestSystem()).not.toBeNull();
    expect(service.getLatestInstance(instance.id)?.cpu).toBe(5);

    const before = messages.length;
    service.setSystemActive(false);
    service.setInstanceActive(instance.id, false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(messages.length).toBe(before);
    service.stop();
  });

  it('keeps sampling after a system sample rejects', async () => {
    vi.useFakeTimers();
    const ctx = createTestDb();
    contexts.push(ctx);
    const system = vi
      .fn<MetricsCollector['system']>()
      .mockRejectedValueOnce(new Error('EBUSY: resource busy or locked, read'))
      .mockResolvedValue(systemSample());
    const collector: MetricsCollector = {
      system,
      instance: async () => ({ ts: new Date().toISOString(), cpu: 1, memBytes: 1, diskFreeBytes: 1 }),
    };
    const service = new MetricsService({
      collector,
      supervisor: {} as InstanceSupervisor,
      db: ctx.db,
      dataDir: ctx.dir,
    });
    const messages: ServerWsMessage[] = [];
    service.setSink((message) => messages.push(message));

    service.setSystemActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(system).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(system).toHaveBeenCalledTimes(2);
    expect(messages.some((message) => message.type === 'metrics.sample' && message.target === 'system')).toBe(true);
    service.stop();
  });

  it('skips instances that are not running and keeps at most 60 samples', async () => {
    const ctx = createTestDb();
    contexts.push(ctx);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-metrics-'));
    dirs.push(root);
    const instance = insertInstanceRow(ctx.db, { name: 'idle', rootPath: root });
    let calls = 0;
    const collector: MetricsCollector = {
      system: async () => systemSample(),
      instance: async () => {
        calls += 1;
        return { ts: new Date().toISOString(), cpu: 1, memBytes: 1, diskFreeBytes: 1 };
      },
    };
    const stopped = {
      getStatus: () => ({
        instanceId: instance.id,
        state: 'stopped',
        pid: null,
        startedAt: null,
        exitCode: null,
        error: null,
      }),
    } as unknown as InstanceSupervisor;
    const service = new MetricsService({ collector, supervisor: stopped, db: ctx.db, dataDir: ctx.dir });
    service.setInstanceActive(instance.id, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(0);
    expect(service.getLatestInstance(instance.id)).toBeNull();

    const running = {
      getStatus: () => ({
        instanceId: instance.id,
        state: 'running',
        pid: 7,
        startedAt: null,
        exitCode: null,
        error: null,
      }),
    } as unknown as InstanceSupervisor;
    const busy = new MetricsService({ collector, supervisor: running, db: ctx.db, dataDir: ctx.dir });
    busy.setInstanceActive(instance.id, true);
    await new Promise((resolve) => setTimeout(resolve, 3200));
    busy.setInstanceActive(instance.id, false);
    busy.stop();
    expect(calls).toBeGreaterThan(0);
    expect(ctx.db.select().from(instances).all()).toHaveLength(1);
  }, 20000);

  it('reports the system overview immediately', async () => {
    const ctx = createTestDb();
    contexts.push(ctx);
    const service = new MetricsService({
      collector: { system: async () => systemSample(42), instance: async () => ({ ts: '', cpu: 0, memBytes: 0, diskFreeBytes: 0 }) },
      supervisor: {} as InstanceSupervisor,
      db: ctx.db,
      dataDir: ctx.dir,
    });
    expect((await service.getSystemOverview()).cpuPercent).toBe(42);
    expect(service.getLatestSystem()?.cpuPercent).toBe(42);
  });

  it('reads real disk usage for an existing path', async () => {
    const ctx = createTestDb();
    contexts.push(ctx);
    const usage = await diskUsage(ctx.dir);
    expect(usage.total).toBeGreaterThan(0);
    expect(usage.free).toBeGreaterThan(0);
    expect(usage.free).toBeLessThanOrEqual(usage.total);
  });
});

describe('collectTreePids', () => {
  const processes = [
    { pid: 100, parentPid: 1 },
    { pid: 101, parentPid: 100 },
    { pid: 102, parentPid: 101 },
    { pid: 200, parentPid: 5 },
    { pid: 5, parentPid: 4 },
  ];

  it('includes the wrapper shell and every descendant', () => {
    expect(collectTreePids(processes, 100).sort()).toEqual([100, 101, 102]);
  });

  it('returns only the root when the subtree is empty', () => {
    expect(collectTreePids(processes, 200)).toEqual([200]);
  });

  it('survives a parent cycle instead of looping forever', () => {
    const cyclic = [
      { pid: 7, parentPid: 8 },
      { pid: 8, parentPid: 7 },
    ];
    expect(collectTreePids(cyclic, 7).sort()).toEqual([7, 8]);
  });
});
