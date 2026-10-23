import type { FastifyInstance } from 'fastify';
import { auditQuerySchema } from '@mcpanel/shared';
import { createGuards } from '../auth/guard';
import type { SessionService } from '../auth/session';
import type { AuditService } from '../services/audit-service';

export function registerAuditRoutes(app: FastifyInstance, deps: { sessions: SessionService; audit: AuditService }): void {
  const { requireAuth } = createGuards(deps.sessions);
  app.get('/api/audit', { preHandler: [requireAuth] }, async (request) => {
    const query = auditQuerySchema.parse(request.query);
    return deps.audit.list(query);
  });
}
