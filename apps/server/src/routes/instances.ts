import fs from 'node:fs';
import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  consoleCommandSchema,
  createInstanceSchema,
  deleteInstanceSchema,
  logsQuerySchema,
  markStoppedSchema,
  probeSchema,
  updateInstanceSchema,
  type InstanceInfo,
  type InstanceStatusSnapshot,
} from '@mcpanel/shared';
import { createGuards } from '../auth/guard';
import type { SessionService } from '../auth/session';
import type { LocalNodeDriver } from '../nodes/local-driver';
import type { AuditService } from '../services/audit-service';
import type { InstanceService } from '../services/instance-service';
import { toInstanceInfo } from '../services/instance-serializer';
import type { InstanceSupervisor } from '../services/instance-supervisor';
import type { ProbeService } from '../services/probe-service';
import type { RconService } from '../services/rcon-service';
import { AppError } from '../utils/errors';

export interface InstanceRouteDeps {
  sessions: SessionService;
  audit: AuditService;
  instances: InstanceService;
  supervisor: InstanceSupervisor;
  rcon: RconService;
  driver: LocalNodeDriver;
  probe: ProbeService;
}

export function registerInstanceRoutes(app: FastifyInstance, deps: InstanceRouteDeps): void {
  const { audit, instances, supervisor, rcon, driver, probe } = deps;
  const { requireAuth, requireOrigin } = createGuards(deps.sessions);
  const read = { preHandler: [requireAuth] };
  const write = { preHandler: [requireOrigin, requireAuth, app.csrfProtection] };

  const detail = async (instanceId: string): Promise<InstanceInfo> => {
    const row = instances.get(instanceId);
    return toInstanceInfo(row, supervisor.getStatus(instanceId), await rcon.statusFor(row));
  };

  const withInstance = (instanceId: string): InstanceStatusSnapshot => {
    instances.get(instanceId);
    return supervisor.getStatus(instanceId);
  };

  app.get('/api/instances', read, async () => ({
    items: await Promise.all(
      instances.list().map(async (row) => toInstanceInfo(row, supervisor.getStatus(row.id), await rcon.statusFor(row))),
    ),
  }));

  app.post('/api/instances/probe', write, async (request) => {
    const input = probeSchema.parse(request.body);
    return probe.probe(input.rootPath, instances.list().map((row) => row.rootPath));
  });

  app.post('/api/instances', write, async (request, reply) => {
    const input = createInstanceSchema.parse(request.body);
    const root = await driver.validateRoot(input.rootPath, instances.list().map((row) => row.rootPath));
    const row = instances.create(input, root);
    audit.record({
      userId: request.user?.id,
      action: 'instance.create',
      targetType: 'instance',
      targetId: row.id,
      detail: { name: row.name, rootPath: row.rootPath },
      ip: request.ip,
    });
    return reply.status(201).send(await detail(row.id));
  });

  app.get<{ Params: { id: string } }>('/api/instances/:id', read, async (request) => detail(request.params.id));

  app.patch<{ Params: { id: string } }>('/api/instances/:id', write, async (request) => {
    const patch = updateInstanceSchema.parse(request.body);
    const before = instances.get(request.params.id);
    const row = instances.update(request.params.id, patch);
    if (patch.rconHost !== undefined && patch.rconHost !== before.rconHost) rcon.invalidate(row.id);
    audit.record({
      userId: request.user?.id,
      action: 'instance.update',
      targetType: 'instance',
      targetId: row.id,
      detail: { fields: Object.keys(patch) },
      ip: request.ip,
    });
    return await detail(row.id);
  });

  app.delete<{ Params: { id: string } }>('/api/instances/:id', write, async (request, reply) => {
    const input = deleteInstanceSchema.parse(request.body);
    const row = instances.get(request.params.id);
    instances.delete(row, input.confirmName);
    audit.record({
      userId: request.user?.id,
      action: 'instance.delete',
      targetType: 'instance',
      targetId: row.id,
      detail: { name: row.name },
      ip: request.ip,
    });
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/instances/:id/status', read, async (request) =>
    supervisor.getStatus(request.params.id),
  );

  const actions = {
    start: (id: string) => supervisor.start(id),
    stop: (id: string) => supervisor.stop(id),
    restart: (id: string) => supervisor.restart(id),
    kill: (id: string) => supervisor.kill(id),
  } as const;

  for (const [name, run] of Object.entries(actions)) {
    app.post<{ Params: { id: string } }>(`/api/instances/:id/actions/${name}`, write, async (request, reply) => {
      const { id } = request.params;
      withInstance(id);
      await run(id);
      return reply.status(202).send({ state: supervisor.getStatus(id).state });
    });
  }

  app.post<{ Params: { id: string } }>('/api/instances/:id/actions/mark-stopped', write, async (request, reply) => {
    markStoppedSchema.parse(request.body);
    withInstance(request.params.id);
    await supervisor.markStopped(request.params.id);
    return reply.status(202).send({ state: supervisor.getStatus(request.params.id).state });
  });

  app.get<{ Params: { id: string }; Querystring: { lines?: string } }>('/api/instances/:id/logs', read, async (request) => {
    const { lines } = logsQuerySchema.parse(request.query);
    instances.get(request.params.id);
    return { lines: await supervisor.getRecentLines(request.params.id, lines) };
  });

  app.get<{ Params: { id: string } }>('/api/instances/:id/logs/download', read, async (request, reply) => {
    instances.get(request.params.id);
    const file = supervisor.getLogFilePath(request.params.id);
    if (!fs.existsSync(file)) throw new AppError('NOT_FOUND', '日志文件不存在');
    reply.type('text/plain; charset=utf-8').header('Content-Disposition', 'attachment; filename="latest.log"');
    return reply.send(createReadStream(file));
  });

  app.post<{ Params: { id: string } }>('/api/instances/:id/console/command', write, async (request) => {
    const input = consoleCommandSchema.parse(request.body);
    instances.get(request.params.id);
    await supervisor.sendCommand(request.params.id, input.command);
    audit.record({
      userId: request.user?.id,
      action: 'console.command',
      targetType: 'instance',
      targetId: request.params.id,
      detail: { command: input.command },
      ip: request.ip,
    });
    return { ok: true };
  });
}
