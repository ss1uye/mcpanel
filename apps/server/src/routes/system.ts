import type { FastifyInstance } from 'fastify';
import { createGuards } from '../auth/guard';
import type { SessionService } from '../auth/session';
import type { MetricsService } from '../services/metrics-service';

export function registerSystemRoutes(app: FastifyInstance, deps: { sessions: SessionService; metrics: MetricsService }): void {
  const { requireAuth } = createGuards(deps.sessions);
  app.get('/api/system/overview', { preHandler: [requireAuth] }, async () => deps.metrics.getSystemOverview());
}
