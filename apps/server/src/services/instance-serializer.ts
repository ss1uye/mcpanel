import type { InstanceInfo, InstanceStatusSnapshot, RconStatus } from '@mcpanel/shared';
import type { InstanceRow } from '../db/schema';

export function parseExtraPaths(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function toInstanceInfo(
  row: InstanceRow,
  status: InstanceStatusSnapshot,
  rconStatus: RconStatus,
): InstanceInfo {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.rootPath,
    startCommand: row.startCommand,
    javaPath: row.javaPath,
    stopTimeoutSec: row.stopTimeoutSec,
    logEncoding: row.logEncoding,
    rconHost: row.rconHost,
    backupKeep: row.backupKeep,
    backupIncludeMods: row.backupIncludeMods,
    backupIncludeConfig: row.backupIncludeConfig,
    backupExtraPaths: parseExtraPaths(row.backupExtraPaths),
    state: status.state,
    pid: status.pid,
    startedAt: status.startedAt,
    exitCode: status.exitCode,
    lastError: status.error,
    rconStatus,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}
