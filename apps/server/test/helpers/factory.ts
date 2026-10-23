import { randomUUID } from 'node:crypto';
import { toRootKey } from '../../src/nodes/path-sandbox';
import { instances, users, type InstanceRow } from '../../src/db/schema';
import type { DB } from '../../src/db/client';

type InstanceInsert = typeof instances.$inferInsert;

export function insertInstanceRow(db: DB, overrides: Partial<InstanceInsert> = {}): InstanceRow {
  const id = overrides.id ?? randomUUID();
  const rootPath = overrides.rootPath ?? `C:\\servers\\${id}`;
  const now = Date.now();
  const base: InstanceInsert = {
    id,
    nodeId: 'local',
    name: `实例-${id.slice(0, 8)}`,
    rootPath,
    rootPathKey: toRootKey(rootPath),
    startCommand: 'run.bat',
    javaPath: null,
    stopTimeoutSec: 30,
    logEncoding: 'utf-8',
    rconHost: null,
    backupKeep: 10,
    backupIncludeMods: false,
    backupIncludeConfig: true,
    backupExtraPaths: '[]',
    lastState: 'stopped',
    lastPid: null,
    lastStartedAt: null,
    lastExitCode: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  const row: InstanceInsert = { ...base, ...overrides, id, rootPath, rootPathKey: toRootKey(rootPath) };
  db.insert(instances).values(row).run();
  return row as InstanceRow;
}

export function insertInstance(db: DB, overrides: Partial<InstanceInsert> = {}): string {
  return insertInstanceRow(db, overrides).id;
}

export function insertUser(db: DB, username = 'admin', passwordHash = '$argon2id$placeholder'): string {
  const id = randomUUID();
  const now = Date.now();
  db.insert(users).values({ id, username, passwordHash, role: 'admin', createdAt: now, updatedAt: now }).run();
  return id;
}
