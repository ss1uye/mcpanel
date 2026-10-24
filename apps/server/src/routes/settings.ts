import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { panelSettingsPatchSchema } from '@mcpanel/shared';
import { createGuards } from '../auth/guard';
import type { SessionService } from '../auth/session';
import type { AuditService } from '../services/audit-service';
import type { PanelBackupService } from '../services/panel-backup-service';
import type { SettingsService } from '../services/settings-service';

export function registerSettingsRoutes(
  app: FastifyInstance,
  deps: {
    sessions: SessionService;
    audit: AuditService;
    settings: SettingsService;
    panelBackup?: PanelBackupService;
  },
): void {
  const { sessions, audit, settings, panelBackup } = deps;
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

  if (panelBackup) {
    app.get('/api/settings/panel-backup', { preHandler: [requireAuth] }, async (request, reply) => {
      const snapshot = await panelBackup.createSnapshot();
      audit.record({
        userId: request.user?.id,
        action: 'panel.backup',
        targetType: 'panel',
        targetId: null,
        detail: { filename: snapshot.filename, sizeBytes: snapshot.sizeBytes },
        ip: request.ip,
      });
      const stream = createReadStream(snapshot.path);
      const cleanup = () => {
        void fs.rm(snapshot.path, { force: true });
      };
      stream.on('close', cleanup);
      stream.on('error', cleanup);
      reply.type('application/vnd.sqlite3');
      reply.header('Content-Disposition', `attachment; filename="${snapshot.filename}"`);
      return reply.send(stream);
    });
  }
}
