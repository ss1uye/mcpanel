import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, type DbHandle } from '../../src/db/client';
import { runMigrations, seedLocalNode } from '../../src/db/migrate';

const migrationsDir = fileURLToPath(new URL('../../drizzle', import.meta.url));

export interface TestDb extends DbHandle {
  dir: string;
  close: () => void;
}

export function createTestDb(): TestDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpanel-db-'));
  const handle = openDatabase(path.join(dir, 'panel.db'));
  runMigrations(handle.sqlite, migrationsDir);
  seedLocalNode(handle.db);
  return {
    ...handle,
    dir,
    close() {
      handle.sqlite.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
