import { randomUUID } from 'node:crypto';
import { instances, users } from '../../src/db/schema';
import type { DB } from '../../src/db/client';

export function insertInstance(db: DB, overrides: Partial<typeof instances.$inferInsert> = {}): string {
  const id = overrides.id ?? randomUUID();
  const rootPath = overrides.rootPath ?? `C:\\servers\\${id}`;
  db.insert(instances)
    .values({
      id,
      nodeId: 'local',
      name: overrides.name ?? `实例-${id.slice(0, 8)}`,
      rootPath,
      rootPathKey: rootPath.toLowerCase().replaceAll('\\', '/'),
      startCommand: 'run.bat',
      stopTimeoutSec: 30,
      logEncoding: 'utf-8',
      backupKeep: 10,
      backupIncludeMods: false,
      backupIncludeConfig: true,
      backupExtraPaths: '[]',
      lastState: 'stopped',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    })
    .run();
  return id;
}

export function insertUser(db: DB, username = 'admin', passwordHash = '$argon2id$placeholder'): string {
  const id = randomUUID();
  const now = Date.now();
  db.insert(users).values({ id, username, passwordHash, role: 'admin', createdAt: now, updatedAt: now }).run();
  return id;
}
