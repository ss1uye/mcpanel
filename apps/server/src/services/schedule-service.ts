import { randomUUID } from 'node:crypto';
import type { ScheduleActionType, ScheduleInfo, ScheduleRunInfo } from '@mcpanel/shared';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { Cron } from 'croner';
import type { DB } from '../db/client';
import { scheduleRuns, schedules, type InstanceRow } from '../db/schema';
import { AppError } from '../utils/errors';
import type { BackupService } from './backup-service';
import type { InstanceService } from './instance-service';
import type { InstanceSupervisor } from './instance-supervisor';

export interface ScheduleInput {
  name: string;
  cron: string;
  timezone: string;
  actionType: ScheduleActionType;
  command?: string | null;
  message?: string | null;
  enabled: boolean;
}

export interface ScheduleServiceDeps {
  db: DB;
  instances: InstanceService;
  supervisor: InstanceSupervisor;
  backups: BackupService;
  logger: Logger;
}

const MAX_RUNS_PER_SCHEDULE = 100;

function toInfo(row: typeof schedules.$inferSelect): ScheduleInfo {
  const payload = JSON.parse(row.payloadJson) as { command?: string; message?: string };
  return {
    id: row.id,
    instanceId: row.instanceId,
    name: row.name,
    cron: row.cron,
    timezone: row.timezone,
    actionType: row.actionType,
    command: payload.command ?? null,
    message: payload.message ?? null,
    enabled: row.enabled,
    lastRunAt: row.lastRunAt === null ? null : new Date(row.lastRunAt).toISOString(),
    nextRunAt: row.nextRunAt === null ? null : new Date(row.nextRunAt).toISOString(),
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

function toRunInfo(row: typeof scheduleRuns.$inferSelect): ScheduleRunInfo {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    trigger: row.trigger,
    status: row.status,
    message: row.message,
    startedAt: new Date(row.startedAt).toISOString(),
    finishedAt: row.finishedAt === null ? null : new Date(row.finishedAt).toISOString(),
  };
}

export class ScheduleService {
  private readonly jobs = new Map<string, Cron>();
  private readonly running = new Set<string>();

  constructor(private readonly deps: ScheduleServiceDeps) {}

  list(row: InstanceRow): ScheduleInfo[] {
    return this.deps.db
      .select()
      .from(schedules)
      .where(eq(schedules.instanceId, row.id))
      .orderBy(asc(schedules.createdAt))
      .all()
      .map(toInfo);
  }

  runs(row: InstanceRow, scheduleId: string): ScheduleRunInfo[] {
    this.get(row, scheduleId);
    return this.deps.db
      .select()
      .from(scheduleRuns)
      .where(eq(scheduleRuns.scheduleId, scheduleId))
      .orderBy(desc(scheduleRuns.startedAt))
      .limit(MAX_RUNS_PER_SCHEDULE)
      .all()
      .map(toRunInfo);
  }

  nextRuns(schedule: ScheduleInfo): string[] {
    const job = new Cron(schedule.cron, { timezone: schedule.timezone, paused: true });
    try {
      return job.nextRuns(3).map((date) => date.toISOString());
    } finally {
      job.stop();
    }
  }

  create(row: InstanceRow, input: ScheduleInput): ScheduleInfo {
    const next = this.validate(input);
    const id = randomUUID();
    const now = Date.now();
    this.deps.db
      .insert(schedules)
      .values({
        id,
        instanceId: row.id,
        name: input.name,
        cron: input.cron,
        timezone: input.timezone,
        actionType: input.actionType,
        payloadJson: JSON.stringify({ command: input.command ?? undefined, message: input.message ?? undefined }),
        enabled: input.enabled,
        nextRunAt: input.enabled ? next : null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const created = this.get(row, id);
    this.reschedule(created);
    return created;
  }

  update(row: InstanceRow, scheduleId: string, patch: Partial<ScheduleInput>): ScheduleInfo {
    const current = this.get(row, scheduleId);
    const merged: ScheduleInput = {
      name: patch.name ?? current.name,
      cron: patch.cron ?? current.cron,
      timezone: patch.timezone ?? current.timezone,
      actionType: patch.actionType ?? current.actionType,
      command: patch.command !== undefined ? patch.command : current.command,
      message: patch.message !== undefined ? patch.message : current.message,
      enabled: patch.enabled ?? current.enabled,
    };
    const next = this.validate(merged);
    this.deps.db
      .update(schedules)
      .set({
        name: merged.name,
        cron: merged.cron,
        timezone: merged.timezone,
        actionType: merged.actionType,
        payloadJson: JSON.stringify({ command: merged.command ?? undefined, message: merged.message ?? undefined }),
        enabled: merged.enabled,
        nextRunAt: merged.enabled ? next : null,
        updatedAt: Date.now(),
      })
      .where(eq(schedules.id, scheduleId))
      .run();
    const updated = this.get(row, scheduleId);
    this.reschedule(updated);
    return updated;
  }

  remove(row: InstanceRow, scheduleId: string): void {
    this.get(row, scheduleId);
    this.jobs.get(scheduleId)?.stop();
    this.jobs.delete(scheduleId);
    this.deps.db.delete(schedules).where(eq(schedules.id, scheduleId)).run();
  }

  async runNow(row: InstanceRow, scheduleId: string): Promise<ScheduleRunInfo> {
    return this.execute(row, this.get(row, scheduleId), 'manual');
  }

  start(): void {
    for (const row of this.deps.instances.list()) {
      for (const schedule of this.list(row)) {
        if (schedule.enabled) this.reschedule(schedule);
      }
    }
  }

  stop(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  forgetInstance(instanceId: string): void {
    for (const schedule of this.deps.db.select().from(schedules).where(eq(schedules.instanceId, instanceId)).all()) {
      this.jobs.get(schedule.id)?.stop();
      this.jobs.delete(schedule.id);
    }
  }

  private validate(input: ScheduleInput): number | null {
    let job: Cron;
    try {
      job = new Cron(input.cron, { timezone: input.timezone, paused: true });
    } catch {
      throw new AppError('INVALID_CRON', 'cron 表达式或时区无效');
    }
    try {
      const next = job.nextRun();
      return next ? next.getTime() : null;
    } finally {
      job.stop();
    }
  }

  private reschedule(schedule: ScheduleInfo): void {
    this.jobs.get(schedule.id)?.stop();
    this.jobs.delete(schedule.id);
    if (!schedule.enabled) return;
    const row = this.deps.instances.get(schedule.instanceId);
    const job = new Cron(schedule.cron, { timezone: schedule.timezone, protect: true }, () => {
      void this.execute(row, schedule, 'scheduled').catch((error: unknown) => {
        this.deps.logger.error({ err: error, scheduleId: schedule.id }, 'scheduled run failed');
      });
    });
    this.jobs.set(schedule.id, job);
  }

  private async execute(
    row: InstanceRow,
    schedule: ScheduleInfo,
    trigger: 'scheduled' | 'manual',
  ): Promise<ScheduleRunInfo> {
    const startedAt = Date.now();
    if (this.running.has(schedule.id)) {
      return this.recordRun(schedule.id, trigger, 'skipped', '上一次运行尚未结束', startedAt, Date.now());
    }
    this.running.add(schedule.id);
    const runId = randomUUID();
    this.deps.db
      .insert(scheduleRuns)
      .values({ id: runId, scheduleId: schedule.id, trigger, status: 'running', startedAt })
      .run();
    let status: 'success' | 'failed' | 'skipped' = 'success';
    let message: string | null = null;
    try {
      const outcome = await this.perform(row, schedule);
      status = outcome.status;
      message = outcome.message;
    } catch (error) {
      status = 'failed';
      message = error instanceof AppError ? error.message : '执行失败';
    } finally {
      this.running.delete(schedule.id);
      this.deps.db
        .update(scheduleRuns)
        .set({ status, message, finishedAt: Date.now() })
        .where(eq(scheduleRuns.id, runId))
        .run();
      this.deps.db
        .update(schedules)
        .set({ lastRunAt: startedAt, nextRunAt: this.nextRunAt(schedule), updatedAt: Date.now() })
        .where(eq(schedules.id, schedule.id))
        .run();
      this.trimRuns(schedule.id);
    }
    const run = this.deps.db.select().from(scheduleRuns).where(eq(scheduleRuns.id, runId)).get();
    return toRunInfo(run!);
  }

  private async perform(
    row: InstanceRow,
    schedule: ScheduleInfo,
  ): Promise<{ status: 'success' | 'failed' | 'skipped'; message: string | null }> {
    const state = this.deps.supervisor.getStatus(row.id).state;
    switch (schedule.actionType) {
      case 'backup':
        await this.deps.backups.startCreate(row, 'scheduled').done;
        return { status: 'success', message: '备份完成' };
      case 'start':
        if (state === 'running' || state === 'orphaned') return { status: 'skipped', message: '服务器已在运行' };
        if (state !== 'stopped' && state !== 'crashed') return { status: 'failed', message: `当前状态 ${state} 不能启动` };
        await this.deps.supervisor.start(row.id);
        return { status: 'success', message: '已启动' };
      case 'stop':
        if (state === 'stopped' || state === 'crashed') return { status: 'skipped', message: '服务器已停止' };
        await this.deps.supervisor.stop(row.id);
        return { status: 'success', message: '已停止' };
      case 'restart':
        if (state === 'starting' || state === 'stopping' || state === 'unknown') {
          return { status: 'failed', message: `当前状态 ${state} 不能重启` };
        }
        if (state === 'running' || state === 'orphaned') {
          await this.deps.supervisor.restart(row.id);
          return { status: 'success', message: '已重启' };
        }
        await this.deps.supervisor.start(row.id);
        return { status: 'success', message: '已启动' };
      case 'command':
        if (state !== 'running' && state !== 'orphaned') {
          return { status: 'failed', message: '服务器未运行' };
        }
        await this.deps.supervisor.sendCommand(row.id, schedule.command ?? '');
        return { status: 'success', message: '命令已发送' };
      case 'broadcast':
        if (state !== 'running' && state !== 'orphaned') {
          return { status: 'failed', message: '服务器未运行' };
        }
        await this.deps.supervisor.sendCommand(row.id, `say ${schedule.message ?? ''}`);
        return { status: 'success', message: '广播已发送' };
    }
  }

  private recordRun(
    scheduleId: string,
    trigger: 'scheduled' | 'manual',
    status: 'skipped',
    message: string,
    startedAt: number,
    finishedAt: number,
  ): ScheduleRunInfo {
    const id = randomUUID();
    this.deps.db
      .insert(scheduleRuns)
      .values({ id, scheduleId, trigger, status, message, startedAt, finishedAt })
      .run();
    const row = this.deps.db.select().from(scheduleRuns).where(eq(scheduleRuns.id, id)).get();
    return toRunInfo(row!);
  }

  private nextRunAt(schedule: ScheduleInfo): number | null {
    if (!schedule.enabled) return null;
    const job = new Cron(schedule.cron, { timezone: schedule.timezone, paused: true });
    try {
      const next = job.nextRun();
      return next ? next.getTime() : null;
    } finally {
      job.stop();
    }
  }

  private trimRuns(scheduleId: string): void {
    const rows = this.deps.db
      .select({ id: scheduleRuns.id })
      .from(scheduleRuns)
      .where(eq(scheduleRuns.scheduleId, scheduleId))
      .orderBy(desc(scheduleRuns.startedAt))
      .all();
    for (const row of rows.slice(MAX_RUNS_PER_SCHEDULE)) {
      this.deps.db.delete(scheduleRuns).where(eq(scheduleRuns.id, row.id)).run();
    }
  }

  private get(row: InstanceRow, scheduleId: string): ScheduleInfo {
    const found = this.deps.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.id, scheduleId), eq(schedules.instanceId, row.id)))
      .get();
    if (!found) throw new AppError('NOT_FOUND', '计划不存在');
    return toInfo(found);
  }
}
