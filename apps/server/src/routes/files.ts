import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  deleteFileSchema,
  filePathSchema,
  mkdirSchema,
  renameSchema,
  saveFileSchema,
  type FileListResult,
} from '@mcpanel/shared';
import { createGuards } from '../auth/guard';
import type { SessionService } from '../auth/session';
import type { AppConfig } from '../config';
import type { AuditService } from '../services/audit-service';
import type { FileService } from '../services/file-service';
import type { InstanceService } from '../services/instance-service';

export interface FileRouteDeps {
  sessions: SessionService;
  audit: AuditService;
  instances: InstanceService;
  files: FileService;
  config: AppConfig;
}

export function registerFileRoutes(app: FastifyInstance, deps: FileRouteDeps): void {
  const { sessions, audit, instances, files } = deps;
  const { requireAuth, requireOrigin } = createGuards(sessions);
  const read = { preHandler: [requireAuth] };
  const write = { preHandler: [requireOrigin, requireAuth, app.csrfProtection] };

  const rootOf = (id: string): string => instances.get(id).rootPath;

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/instances/:id/files',
    read,
    async (request): Promise<FileListResult> => {
      return files.list(rootOf(request.params.id), filePathSchema.parse(request.query.path));
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/instances/:id/files/content',
    read,
    async (request) => {
      const relPath = filePathSchema.parse(request.query.path);
      return files.read(rootOf(request.params.id), relPath);
    },
  );

  app.put<{ Params: { id: string } }>('/api/instances/:id/files/content', write, async (request) => {
    const input = saveFileSchema.parse(request.body);
    const saved = await files.save(rootOf(request.params.id), input.path, input.content, input.expectedMtime);
    audit.record({
      userId: request.user?.id,
      action: 'file.save',
      targetType: 'instance',
      targetId: request.params.id,
      detail: { path: input.path, bytes: input.content.length },
      ip: request.ip,
    });
    return saved;
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/instances/:id/files/download',
    read,
    async (request, reply) => {
      const relPath = filePathSchema.parse(request.query.path);
      const target = await files.download(rootOf(request.params.id), relPath);
      const encoded = encodeURIComponent(target.name);
      reply.type('application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`);
      return reply.send(createReadStream(target.file));
    },
  );

  app.post<{ Params: { id: string } }>('/api/instances/:id/files/mkdir', write, async (request, reply) => {
    const input = mkdirSchema.parse(request.body);
    await files.mkdir(rootOf(request.params.id), input.path);
    audit.record({
      userId: request.user?.id,
      action: 'file.mkdir',
      targetType: 'instance',
      targetId: request.params.id,
      detail: { path: input.path },
      ip: request.ip,
    });
    return reply.status(201).send({ ok: true });
  });

  app.post<{ Params: { id: string } }>('/api/instances/:id/files/rename', write, async (request) => {
    const input = renameSchema.parse(request.body);
    const result = await files.rename(rootOf(request.params.id), input.path, input.newName);
    audit.record({
      userId: request.user?.id,
      action: 'file.rename',
      targetType: 'instance',
      targetId: request.params.id,
      detail: { path: input.path, newName: input.newName },
      ip: request.ip,
    });
    return result;
  });

  app.delete<{ Params: { id: string } }>('/api/instances/:id/files', write, async (request, reply) => {
    const input = deleteFileSchema.parse(request.body);
    await files.remove(rootOf(request.params.id), input.path, input.recursive);
    audit.record({
      userId: request.user?.id,
      action: 'file.delete',
      targetType: 'instance',
      targetId: request.params.id,
      detail: { path: input.path, recursive: input.recursive },
      ip: request.ip,
    });
    return reply.status(204).send();
  });
}
