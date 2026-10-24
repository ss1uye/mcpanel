import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { restoreBackupSchema } from '@mcpanel/shared';
import { createGuards } from '../auth/guard';
import type { SessionService } from '../auth/session';
import type { AuditService } from '../services/audit-service';
import type { BackupService } from '../services/backup-service';
import type { InstanceService } from '../services/instance-service';
import type { RestoreService } from '../services/restore-service';
import { AppError } from '../utils/errors';

export interface BackupRouteDeps {
  sessions: SessionService;
  audit: AuditService;
  instances: InstanceService;
  backups: BackupService;
  restore: RestoreService;
}

export function registerBackupRoutes(app: FastifyInstance, deps: BackupRouteDeps): void {
  const { sessions, audit, instances, backups, restore } = deps;
  const { requireAuth, requireOrigin } = createGuards(sessions);
  const read = { preHandler: [requireAuth] };
  const write = { preHandler: [requireOrigin, requireAuth, app.csrfProtection] };

  app.get<{ Params: { id: string } }>('/api/instances/:id/backups', read, async (request) => ({
    items: backups.list(request.params.id),
  }));

  app.post<{ Params: { id: string } }>('/api/instances/:id/backups', write, async (request, reply) => {
    const row = instances.get(request.params.id);
    const { task, backupId, done } = backups.startCreate(row, 'manual');
    void done.catch(() => undefined);
    audit.record({
      userId: request.user?.id,
      action: 'backup.create',
      targetType: 'instance',
      targetId: row.id,
      detail: { backupId },
      ip: request.ip,
    });
    return reply.status(202).send({ taskId: task.id, backupId });
  });

  app.get<{ Params: { id: string; backupId: string } }>(
    '/api/instances/:id/backups/:backupId/manifest',
    read,
    async (request) => {
      const manifest = backups.manifest(request.params.id, request.params.backupId);
      if (!manifest) throw new AppError('NOT_FOUND', '备份清单不存在');
      return manifest;
    },
  );

  app.get<{ Params: { id: string; backupId: string } }>(
    '/api/instances/:id/backups/:backupId/download',
    read,
    async (request, reply) => {
      const file = backups.filePath(request.params.id, request.params.backupId);
      reply.type('application/zip');
      reply.header('Content-Disposition', 'attachment; filename="backup.zip"');
      return reply.send(createReadStream(file));
    },
  );

  app.delete<{ Params: { id: string; backupId: string } }>(
    '/api/instances/:id/backups/:backupId',
    write,
    async (request, reply) => {
      const row = instances.get(request.params.id);
      await backups.remove(row, request.params.backupId);
      audit.record({
        userId: request.user?.id,
        action: 'backup.delete',
        targetType: 'instance',
        targetId: row.id,
        detail: { backupId: request.params.backupId },
        ip: request.ip,
      });
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string; backupId: string } }>(
    '/api/instances/:id/backups/:backupId/restore',
    write,
    async (request, reply) => {
      restoreBackupSchema.parse(request.body);
      const row = instances.get(request.params.id);
      const context = await restore.preflight(row, request.params.backupId);
      const { task, done } = restore.start(row, context, request.user?.id ?? null);
      void done.catch(() => undefined);
      return reply.status(202).send({ taskId: task.id });
    },
  );
}
