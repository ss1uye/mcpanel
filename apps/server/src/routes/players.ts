import type { FastifyInstance } from 'fastify';
import { playerActionSchema } from '@mcpanel/shared';
import { createGuards } from '../auth/guard';
import type { SessionService } from '../auth/session';
import type { AuditService } from '../services/audit-service';
import type { InstanceService } from '../services/instance-service';
import type { PlayersService } from '../services/players-service';

export interface PlayerRouteDeps {
  sessions: SessionService;
  audit: AuditService;
  instances: InstanceService;
  players: PlayersService;
}

export function registerPlayerRoutes(app: FastifyInstance, deps: PlayerRouteDeps): void {
  const { sessions, audit, instances, players } = deps;
  const { requireAuth, requireOrigin } = createGuards(sessions);
  const read = { preHandler: [requireAuth] };
  const write = { preHandler: [requireOrigin, requireAuth, app.csrfProtection] };

  app.get<{ Params: { id: string } }>('/api/instances/:id/players', read, async (request) =>
    players.online(instances.get(request.params.id)),
  );

  app.get<{ Params: { id: string } }>('/api/instances/:id/players/lists', read, async (request) =>
    players.lists(instances.get(request.params.id)),
  );

  app.post<{ Params: { id: string } }>('/api/instances/:id/players/actions', write, async (request) => {
    const input = playerActionSchema.parse(request.body);
    const row = instances.get(request.params.id);
    const { command } = await players.act(row, input);
    audit.record({
      userId: request.user?.id,
      action: `player.${input.action}`,
      targetType: 'instance',
      targetId: row.id,
      detail: {
        player: 'player' in input ? input.player : null,
        reason: 'reason' in input && input.reason ? input.reason : null,
        mode: 'mode' in input ? input.mode : null,
        command,
      },
      ip: request.ip,
    });
    return { ok: true };
  });
}
