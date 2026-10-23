import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, type DbHandle } from '../../src/db/client';
import { runMigrations, seedLocalNode } from '../../src/db/migrate';

export const migrationsDir = fileURLToPath(new URL('../../drizzle', import.meta.url));

export interface TestDb extends DbHandle {
  dir: string;
  close: () => void;
}

function openMigratedDb(dir: string): TestDb {
  const handle = openDatabase(path.join(dir, 'panel.db'));
  try {
    runMigrations(handle.sqlite, migrationsDir);
    seedLocalNode(handle.db);
  } catch (error) {
    try {
      handle.sqlite.close();
    } catch {
      // Cleanup failures must not mask the original setup error.
    }
    throw error;
  }

  let closed = false;
  return {
    ...handle,
    dir,
    close() {
      if (closed) return;
      closed = true;
      try {
        handle.sqlite.close();
      } finally {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // Cleanup failures must not mask the original close error.
        }
      }
    },
  };
}

export function createTestDb(): TestDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpanel-db-'));
  try {
    return openMigratedDb(dir);
  } catch (error) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Cleanup failures must not mask the original setup error.
    }
    throw error;
  }
}
