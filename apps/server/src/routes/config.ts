import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { eulaSchema, propertiesSaveSchema, type PropertiesPayload } from '@mcpanel/shared';
import { createGuards } from '../auth/guard';
import type { SessionService } from '../auth/session';
import type { PathSandbox } from '../nodes/path-sandbox';
import type { AuditService } from '../services/audit-service';
import type { InstanceService } from '../services/instance-service';
import { loadServerProperties } from '../services/properties-service';
import { patchEula, patchProperties, validatePropertyChanges } from '../services/properties-patch';
import type { RconService } from '../services/rcon-service';
import { AppError } from '../utils/errors';
import { writeFileAtomic } from '../utils/fs-atomic';

export interface ConfigRouteDeps {
  sessions: SessionService;
  audit: AuditService;
  instances: InstanceService;
  rcon: RconService;
  sandbox: PathSandbox;
}

async function readEulaFlag(sandbox: PathSandbox, root: string): Promise<boolean> {
  const file = await sandbox.resolve(root, 'eula.txt').catch(() => null);
  if (!file) return false;
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  if (raw === null) return false;
  return /^\s*_?eula\s*=\s*true\s*$/im.test(raw);
}

export function registerConfigRoutes(app: FastifyInstance, deps: ConfigRouteDeps): void {
  const { sessions, audit, instances, rcon, sandbox } = deps;
  const { requireAuth, requireOrigin } = createGuards(sessions);
  const read = { preHandler: [requireAuth] };
  const write = { preHandler: [requireOrigin, requireAuth, app.csrfProtection] };

  app.get<{ Params: { id: string } }>(
    '/api/instances/:id/config/properties',
    read,
    async (request): Promise<PropertiesPayload> => {
      const row = instances.get(request.params.id);
      const loaded = await loadServerProperties(row.rootPath, sandbox);
      if (!loaded) throw new AppError('NOT_FOUND', 'server.properties 不存在');
      return { ...loaded.parsed, raw: loaded.raw, mtime: loaded.mtime, eula: await readEulaFlag(sandbox, row.rootPath) };
    },
  );

  app.put<{ Params: { id: string } }>('/api/instances/:id/config/properties', write, async (request) => {
    const row = instances.get(request.params.id);
    const input = propertiesSaveSchema.parse(request.body);
    const loaded = await loadServerProperties(row.rootPath, sandbox);
    if (!loaded) throw new AppError('NOT_FOUND', 'server.properties 不存在');
    if (Math.abs(loaded.mtime - input.expectedMtime) > 0.5) {
      throw new AppError('MTIME_CONFLICT', '文件已被外部修改');
    }
    validatePropertyChanges(input.changes);
    const next = patchProperties(loaded.raw, input.changes);
    const file = await sandbox.resolve(row.rootPath, 'server.properties');
    await writeFileAtomic(file, next);
    rcon.invalidate(row.id);
    audit.record({
      userId: request.user?.id,
      action: 'config.update',
      targetType: 'instance',
      targetId: row.id,
      detail: { keys: Object.keys(input.changes) },
      ip: request.ip,
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/instances/:id/config/eula', write, async (request) => {
    eulaSchema.parse(request.body);
    const row = instances.get(request.params.id);
    const file = await sandbox.resolve(row.rootPath, 'eula.txt');
    const stat = await fs.lstat(file).catch(() => null);
    if (stat?.isDirectory()) throw new AppError('UNSUPPORTED_FILE', 'eula.txt 是目录，请手动处理');
    const existing = stat ? await fs.readFile(file, 'utf8') : null;
    await writeFileAtomic(file, patchEula(existing));
    audit.record({
      userId: request.user?.id,
      action: 'instance.eula_accept',
      targetType: 'instance',
      targetId: row.id,
      ip: request.ip,
    });
    return { ok: true };
  });
}
