import type { FastifyInstance } from 'fastify';
import { createScheduleSchema, updateScheduleSchema } from '@mcpanel/shared';
import { createGuards } from '../auth/guard';
import type { SessionService } from '../auth/session';
import type { AuditService } from '../services/audit-service';
import type { InstanceService } from '../services/instance-service';
import type { ScheduleService } from '../services/schedule-service';
import type { SettingsService } from '../services/settings-service';
import { AppError } from '../utils/errors';

export interface ScheduleRouteDeps {
  sessions: SessionService;
  audit: AuditService;
  instances: InstanceService;
  schedules: ScheduleService;
  settings: SettingsService;
}

export function registerScheduleRoutes(app: FastifyInstance, deps: ScheduleRouteDeps): void {
  const { sessions, audit, instances, schedules, settings } = deps;
  const { requireAuth, requireOrigin } = createGuards(sessions);
  const read = { preHandler: [requireAuth] };
  const write = { preHandler: [requireOrigin, requireAuth, app.csrfProtection] };

  app.get<{ Params: { id: string } }>('/api/instances/:id/schedules', read, async (request) => ({
    items: schedules.list(instances.get(request.params.id)),
  }));

  app.post<{ Params: { id: string } }>('/api/instances/:id/schedules', write, async (request, reply) => {
    const row = instances.get(request.params.id);
    const timezone = (request.body as { timezone?: string }).timezone ?? settings.get().defaultTimezone;
    const input = createScheduleSchema.parse({ ...(request.body as object), timezone });
    const created = schedules.create(row, input);
    audit.record({
      userId: request.user?.id,
      action: 'schedule.create',
      targetType: 'instance',
      targetId: row.id,
      detail: { scheduleId: created.id, actionType: created.actionType },
      ip: request.ip,
    });
    return reply.status(201).send(created);
  });

  app.patch<{ Params: { id: string; scheduleId: string } }>(
    '/api/instances/:id/schedules/:scheduleId',
    write,
    async (request) => {
      const row = instances.get(request.params.id);
      const patch = updateScheduleSchema.parse(request.body);
      const updated = schedules.update(row, request.params.scheduleId, patch);
      audit.record({
        userId: request.user?.id,
        action: 'schedule.update',
        targetType: 'instance',
        targetId: row.id,
        detail: { scheduleId: updated.id, fields: Object.keys(patch) },
        ip: request.ip,
      });
      return updated;
    },
  );

  app.delete<{ Params: { id: string; scheduleId: string } }>(
    '/api/instances/:id/schedules/:scheduleId',
    write,
    async (request, reply) => {
      const row = instances.get(request.params.id);
      schedules.remove(row, request.params.scheduleId);
      audit.record({
        userId: request.user?.id,
        action: 'schedule.delete',
        targetType: 'instance',
        targetId: row.id,
        detail: { scheduleId: request.params.scheduleId },
        ip: request.ip,
      });
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string; scheduleId: string } }>(
    '/api/instances/:id/schedules/:scheduleId/run',
    write,
    async (request, reply) => {
      const row = instances.get(request.params.id);
      if (schedules.list(row).every((schedule) => schedule.id !== request.params.scheduleId)) {
        throw new AppError('NOT_FOUND', '计划不存在');
      }
      const run = await schedules.runNow(row, request.params.scheduleId);
      audit.record({
        userId: request.user?.id,
        action: 'schedule.run',
        targetType: 'instance',
        targetId: row.id,
        detail: { scheduleId: request.params.scheduleId, status: run.status },
        ip: request.ip,
      });
      return reply.send(run);
    },
  );

  app.get<{ Params: { id: string; scheduleId: string } }>(
    '/api/instances/:id/schedules/:scheduleId/runs',
    read,
    async (request) => ({ items: schedules.runs(instances.get(request.params.id), request.params.scheduleId) }),
  );
}
