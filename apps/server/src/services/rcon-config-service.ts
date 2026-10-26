import crypto from 'node:crypto';
import type { RconEnableResult } from '@mcpanel/shared';
import type { InstanceRow } from '../db/schema';
import type { PathSandbox } from '../nodes/path-sandbox';
import { AppError } from '../utils/errors';
import { writeFileAtomic } from '../utils/fs-atomic';
import type { InstanceService } from './instance-service';
import { patchProperties } from './properties-patch';
import {
  clearServerPropertiesCache,
  loadServerProperties,
  parsePort,
  propertyValue,
} from './properties-service';
import type { RconService } from './rcon-service';

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const PORT_RANGE_START = 25575;
const PORT_RANGE_END = 25584;

export function generateRconPassword(length = 16): string {
  let password = '';
  for (let index = 0; index < length; index += 1) {
    password += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  }
  return password;
}

export class RconConfigService {
  constructor(
    private readonly sandbox: PathSandbox,
    private readonly instances: InstanceService,
    private readonly rcon: RconService,
  ) {}

  async enable(row: InstanceRow): Promise<RconEnableResult> {
    const loaded = await loadServerProperties(row.rootPath, this.sandbox);
    if (!loaded) throw new AppError('NOT_FOUND', 'server.properties 不存在');

    const usedPorts = await this.usedPorts(row.id);
    const currentPort = parsePort(propertyValue(loaded.parsed, 'rcon.port', '25575'), 25575);
    let port: number | null = usedPorts.has(currentPort) ? null : currentPort;
    if (port === null) {
      for (let candidate = PORT_RANGE_START; candidate <= PORT_RANGE_END; candidate += 1) {
        if (!usedPorts.has(candidate)) {
          port = candidate;
          break;
        }
      }
    }
    if (port === null) {
      throw new AppError('PORT_IN_USE', `RCON 端口 ${PORT_RANGE_START}–${PORT_RANGE_END} 均已被其他实例占用`);
    }

    const password = generateRconPassword();
    const next = patchProperties(loaded.raw, {
      'enable-rcon': 'true',
      'rcon.port': String(port),
      'rcon.password': password,
    });
    const file = await this.sandbox.resolve(row.rootPath, 'server.properties');
    await writeFileAtomic(file, next);
    clearServerPropertiesCache();
    this.rcon.invalidate(row.id);
    return { port, password };
  }

  private async usedPorts(excludeId: string): Promise<Set<number>> {
    const ports = new Set<number>();
    for (const other of this.instances.list()) {
      if (other.id === excludeId) continue;
      const loaded = await loadServerProperties(other.rootPath, this.sandbox).catch(() => null);
      ports.add(parsePort(propertyValue(loaded?.parsed ?? null, 'rcon.port', '25575'), 25575));
    }
    return ports;
  }
}
