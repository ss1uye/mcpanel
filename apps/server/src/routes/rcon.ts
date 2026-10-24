import type { FastifyInstance } from 'fastify';
import { createGuards } from '../auth/guard';
import type { SessionService } from '../auth/session';
import type { AuditService } from '../services/audit-service';
import type { InstanceService } from '../services/instance-service';
import type { RconConfigService } from '../services/rcon-config-service';
import type { RconService } from '../services/rcon-service';

export interface RconRouteDeps {
  sessions: SessionService;
  audit: AuditService;
  instances: InstanceService;
  rcon: RconService;
  rconConfig: RconConfigService;
}

export function registerRconRoutes(app: FastifyInstance, deps: RconRouteDeps): void {
  const { audit, instances, rcon, rconConfig, sessions } = deps;
  const { requireAuth, requireOrigin } = createGuards(sessions);
  const write = { preHandler: [requireOrigin, requireAuth, app.csrfProtection] };

  app.post<{ Params: { id: string } }>('/api/instances/:id/rcon/test', write, async (request) =>
    rcon.test(instances.get(request.params.id)),
  );

  app.post<{ Params: { id: string } }>('/api/instances/:id/rcon/enable', write, async (request) => {
    const row = instances.get(request.params.id);
    const result = await rconConfig.enable(row);
    audit.record({
      userId: request.user?.id,
      action: 'instance.rcon_enable',
      targetType: 'instance',
      targetId: row.id,
      detail: { port: result.port },
      ip: request.ip,
    });
    return { ...result, restartRequired: true };
  });
}
