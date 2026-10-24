import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../src/services/audit-service';
import { schedules } from '../../src/db/schema';
import { silentLogger } from '../../src/logger';
import { ScheduleService, nextRunsFor } from '../../src/services/schedule-service';
import { AppError } from '../../src/utils/errors';
import { createTestDb, type TestDb } from '../helpers/db';
import { insertInstanceRow } from '../helpers/factory';

let ctx: TestDb | undefined;
let dir: string;

async function setup() {
  ctx = createTestDb();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-schedule-'));
  const root = path.join(dir, 'server');
  await fs.mkdir(root, { recursive: true });
  const instance = insertInstanceRow(ctx.db, { rootPath: root });
  // Mirrors InstanceService.get: undefined row (deleted) surfaces as NOT_FOUND.
  let currentInstance: typeof instance | undefined = instance;
  let state: 'stopped' | 'running' = 'stopped';
  const sendCommand = vi.fn(async () => undefined);
  const start = vi.fn(async () => {
    state = 'running';
  });
  const stop = vi.fn(async () => {
    state = 'stopped';
  });
  const startCreate = vi.fn(() => ({
    task: { id: 't' },
    backupId: 'b',
    done: Promise.resolve(),
  }));
  const service = new ScheduleService({
    db: ctx.db,
    instances: {
      get: () => {
        if (!currentInstance) throw new AppError('NOT_FOUND', '实例不存在');
        return currentInstance;
      },
      list: () => [instance],
    } as never,
    supervisor: {
      getStatus: () => ({
        instanceId: instance.id,
        state,
        pid: null,
        startedAt: null,
        exitCode: null,
        error: null,
      }),
      start,
      stop,
      restart: vi.fn(async () => undefined),
      sendCommand,
    } as never,
    backups: { startCreate } as never,
    audit: new AuditService(ctx.db),
    logger: silentLogger(),
  });
  const schedule = service.create(instance, {
    name: '每小时命令',
    cron: '0 * * * *',
    timezone: 'Asia/Shanghai',
    actionType: 'command',
    command: 'list',
    enabled: true,
  });
  return {
    service,
    instance,
    schedule,
    sendCommand,
    start,
    stop,
    startCreate,
    setCurrent: (row: typeof instance | undefined) => {
      currentInstance = row;
    },
  };
}

afterEach(async () => {
  ctx?.close();
  ctx = undefined;
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe('ScheduleService', () => {
  it('computes the next runs and stores nextRunAt', async () => {
    const { service, instance, schedule } = await setup();
    const listed = service.list(instance)[0]!;
    expect(listed.nextRunAt).not.toBeNull();
    expect(listed.nextRuns).toHaveLength(3);
    expect(nextRunsFor(schedule.cron, schedule.timezone)).toHaveLength(3);
  });

  it('re-reads the instance row at fire time instead of using the creation snapshot', async () => {
    const { service, instance, startCreate, setCurrent } = await setup();
    const backupSchedule = service.create(instance, {
      name: '每日备份',
      cron: '0 4 * * *',
      timezone: 'Asia/Shanghai',
      actionType: 'backup',
      enabled: true,
    });
    const edited = { ...instance, rootPath: `${instance.rootPath}-moved`, backupIncludeMods: !instance.backupIncludeMods };
    setCurrent(edited);

    // runNow hands over the stale row captured before the edit; execute must
    // still act on the current row.
    await service.runNow(instance, backupSchedule.id);
    expect(startCreate).toHaveBeenCalledWith(edited, 'manual');
  });

  it('records a failed run instead of throwing when the instance was deleted', async () => {
    const { service, instance, schedule, setCurrent } = await setup();
    setCurrent(undefined);
    const run = await service.runNow(instance, schedule.id);
    expect(run).toMatchObject({ status: 'failed', message: '实例不存在' });
    expect(service.runs(instance, schedule.id)).toHaveLength(1);
  });

  it('tolerates a corrupt payloadJson instead of failing list() and boot', async () => {
    const { service, instance, schedule } = await setup();
    ctx!.db.update(schedules).set({ payloadJson: '{corrupt' }).where(eq(schedules.id, schedule.id)).run();
    const listed = service.list(instance);
    expect(listed[0]).toMatchObject({ id: schedule.id, command: null, message: null });
  });

  it('rejects invalid cron expressions', async () => {
    const { service, instance } = await setup();
    expect(() =>
      service.create(instance, {
        name: 'bad',
        cron: 'not a cron',
        timezone: 'Asia/Shanghai',
        actionType: 'backup',
        enabled: true,
      }),
    ).toThrow(/cron/);
  });

  it('records a failed command run when the server is stopped', async () => {
    const { service, instance, schedule, sendCommand } = await setup();
    const run = await service.runNow(instance, schedule.id);
    expect(run).toMatchObject({ trigger: 'manual', status: 'failed' });
    expect(run.message).toBe('服务器未运行');
    expect(sendCommand).not.toHaveBeenCalled();
    expect(service.runs(instance, schedule.id)).toHaveLength(1);
    expect(service.list(instance)[0]!.lastRunAt).not.toBeNull();
  });

  it('runs a command when the server is running', async () => {
    const { service, instance, schedule, sendCommand } = await setup();
    await service.runNow(instance, schedule.id); // first run fails (stopped)
    const startSchedule = service.create(instance, {
      name: '启动',
      cron: '*/5 * * * *',
      timezone: 'Asia/Shanghai',
      actionType: 'start',
      enabled: true,
    });
    const startRun = await service.runNow(instance, startSchedule.id);
    expect(startRun.status).toBe('success');
    const commandRun = await service.runNow(instance, schedule.id);
    expect(commandRun.status).toBe('success');
    expect(sendCommand).toHaveBeenCalledWith(instance.id, 'list');
  });

  it('skips overlapping runs of the same schedule', async () => {
    const { service, instance, start } = await setup();
    let release: () => void = () => undefined;
    start.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            resolve();
          };
        }) as never,
    );
    const schedule = service.create(instance, {
      name: '慢启动',
      cron: '*/5 * * * *',
      timezone: 'Asia/Shanghai',
      actionType: 'start',
      enabled: true,
    });
    const first = service.runNow(instance, schedule.id);
    const second = await service.runNow(instance, schedule.id);
    expect(second.status).toBe('skipped');
    release();
    expect((await first).status).toBe('success');
    const runs = service.runs(instance, schedule.id);
    expect(runs.map((run) => run.status).sort()).toEqual(['skipped', 'success']);
  });

  it('keeps at most 100 runs per schedule', async () => {
    const { service, instance, schedule } = await setup();
    for (let index = 0; index < 105; index += 1) {
      ctx!.sqlite
        .prepare(
          `INSERT INTO schedule_runs (id, schedule_id, trigger, status, message, started_at, finished_at) VALUES (?, ?, 'manual', 'success', null, ?, ?)`,
        )
        .run(`run-${index}`, schedule.id, index, index);
    }
    ctx!.sqlite
      .prepare(
        `INSERT INTO schedule_runs (id, schedule_id, trigger, status, message, started_at, finished_at) VALUES ('extra', ?, 'manual', 'success', null, 999, 999)`,
      )
      .run(schedule.id);
    await service.runNow(instance, schedule.id);
    expect(service.runs(instance, schedule.id).length).toBeLessThanOrEqual(100);
  });
});
