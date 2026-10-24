import type { FastifyInstance } from 'fastify';
import { panelSettingsPatchSchema } from '@mcpanel/shared';
import { createGuards } from '../auth/guard';
import type { SessionService } from '../auth/session';
import type { AuditService } from '../services/audit-service';
import type { SettingsService } from '../services/settings-service';

export function registerSettingsRoutes(
  app: FastifyInstance,
  deps: { sessions: SessionService; audit: AuditService; settings: SettingsService },
): void {
  const { sessions, audit, settings } = deps;
  const { requireAuth, requireOrigin } = createGuards(sessions);

  app.get('/api/settings', { preHandler: [requireAuth] }, async () => settings.get());

  app.patch('/api/settings', { preHandler: [requireOrigin, requireAuth, app.csrfProtection] }, async (request) => {
    const patch = panelSettingsPatchSchema.parse(request.body);
    const next = settings.update(patch);
    audit.record({
      userId: request.user?.id,
      action: 'settings.update',
      targetType: 'settings',
      targetId: null,
      detail: { fields: Object.keys(patch) },
      ip: request.ip,
    });
    return next;
  });
}
