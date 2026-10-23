import { Rcon } from 'rcon-client';
import type { RconProbe, RconStatus, RconTarget } from '@mcpanel/shared';
import type { InstanceRow } from '../db/schema';
import { AppError } from '../utils/errors';
import { loadServerProperties, parsePort, propertyValue } from './properties-service';

const CONNECT_TIMEOUT_MS = 5000;

interface CachedConnection {
  client: Rcon;
}

export type TargetResolution =
  | { kind: 'disabled' }
  | { kind: 'missing_password' }
  | { kind: 'ok'; target: RconTarget };

export class RconService {
  private readonly cache = new Map<string, CachedConnection>();
  private readonly statuses = new Map<string, RconStatus>();

  getCachedStatus(instanceId: string): RconStatus {
    return this.statuses.get(instanceId) ?? 'unreachable';
  }

  async resolveTarget(instance: InstanceRow): Promise<TargetResolution> {
    const properties = await loadServerProperties(instance.rootPath);
    const parsed = properties?.parsed ?? null;
    if (propertyValue(parsed, 'enable-rcon', 'false').toLowerCase() !== 'true') return { kind: 'disabled' };
    const password = propertyValue(parsed, 'rcon.password', '');
    if (!password) return { kind: 'missing_password' };
    const serverIp = propertyValue(parsed, 'server-ip', '');
    const host = instance.rconHost ?? (serverIp && serverIp !== '0.0.0.0' ? serverIp : '127.0.0.1');
    return { kind: 'ok', target: { host, port: parsePort(propertyValue(parsed, 'rcon.port', '25575'), 25575), password } };
  }

  async test(instance: InstanceRow): Promise<RconProbe> {
    const resolution = await this.resolveTarget(instance);
    if (resolution.kind === 'disabled') {
      this.setStatus(instance.id, 'disabled');
      return { status: 'disabled', error: '未启用 RCON' };
    }
    if (resolution.kind === 'missing_password') {
      this.setStatus(instance.id, 'auth_failed');
      return { status: 'auth_failed', error: 'RCON 已启用但密码为空' };
    }

    this.disconnect(instance.id);
    let client: Rcon | undefined;
    try {
      client = await Rcon.connect({ ...resolution.target, timeout: CONNECT_TIMEOUT_MS });
      await client.send('list');
      client.on('end', () => {
        if (this.cache.get(instance.id)?.client === client) {
          this.cache.delete(instance.id);
          this.setStatus(instance.id, 'disconnected');
        }
      });
      this.cache.set(instance.id, { client });
      this.setStatus(instance.id, 'connected');
      return { status: 'connected', error: null };
    } catch (error) {
      client?.end();
      const message = error instanceof Error ? error.message : String(error);
      const status: RconStatus = /auth|password|login/i.test(message) ? 'auth_failed' : 'unreachable';
      this.setStatus(instance.id, status);
      return { status, error: redact(message, resolution.target.password) };
    }
  }

  async send(instance: InstanceRow, command: string): Promise<string> {
    let cached = this.cache.get(instance.id);
    if (!cached) {
      const probe = await this.test(instance);
      if (probe.status !== 'connected') {
        throw new AppError('RCON_UNAVAILABLE', probe.error ?? 'RCON 不可用', { status: probe.status });
      }
      cached = this.cache.get(instance.id);
    }
    if (!cached) throw new AppError('RCON_UNAVAILABLE', 'RCON 未连接');
    try {
      return await cached.client.send(command);
    } catch (error) {
      this.disconnect(instance.id);
      this.setStatus(instance.id, 'disconnected');
      throw new AppError('RCON_UNAVAILABLE', error instanceof Error ? error.message : 'RCON 命令失败');
    }
  }

  invalidate(instanceId: string): void {
    this.disconnect(instanceId);
    this.statuses.delete(instanceId);
  }

  closeAll(): void {
    for (const instanceId of [...this.cache.keys()]) this.disconnect(instanceId);
    this.statuses.clear();
  }

  private disconnect(instanceId: string): void {
    const cached = this.cache.get(instanceId);
    if (!cached) return;
    this.cache.delete(instanceId);
    try {
      cached.client.end();
    } catch {
      // already closed
    }
  }

  private setStatus(instanceId: string, status: RconStatus): void {
    this.statuses.set(instanceId, status);
  }
}

function redact(message: string, password: string): string {
  return password ? message.split(password).join('[redacted]') : message;
}
