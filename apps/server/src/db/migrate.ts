import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { nodes } from './schema';
import type { DB } from './client';

/**
 * Migration runner contract:
 * - Each file is executed inside a transaction opened by this runner.
 * - Files must therefore contain plain DDL/DML only: no explicit transaction
 *   control (BEGIN/COMMIT/ROLLBACK) and no `PRAGMA foreign_keys` toggling.
 * - Applied files are immutable; changing one is detected via its checksum and
 *   aborts startup. Add a new migration instead.
 */

interface MigrationRow {
  name: string;
  checksum: string;
}

function checksumOf(sqlText: string): string {
  return createHash('sha256').update(sqlText, 'utf8').digest('hex');
}

export function runMigrations(sqlite: Database.Database, migrationsDir: string): void {
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (' +
      'name TEXT PRIMARY KEY NOT NULL, ' +
      'checksum TEXT NOT NULL, ' +
      'applied_at INTEGER NOT NULL)',
  );

  const applied = new Map(
    (sqlite.prepare('SELECT name, checksum FROM _migrations').all() as MigrationRow[]).map((row) => [
      row.name,
      row.checksum,
    ]),
  );

  const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort();

  // Verify every already applied file before applying anything new, so a modified
  // migration aborts startup without leaving the database half-migrated.
  const pending: Array<{ file: string; sqlText: string; checksum: string }> = [];
  for (const file of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const checksum = checksumOf(sqlText);
    const storedChecksum = applied.get(file);

    if (storedChecksum === undefined) {
      pending.push({ file, sqlText, checksum });
      continue;
    }
    if (storedChecksum !== checksum) {
      throw new Error(
        `Migration "${file}" was modified after it was applied: stored checksum ${storedChecksum} ` +
          `does not match current checksum ${checksum}. Restore the applied file and add a new ` +
          'migration instead of editing history.',
      );
    }
  }

  for (const { file, sqlText, checksum } of pending) {
    const apply = sqlite.transaction(() => {
      sqlite.exec(sqlText);
      sqlite
        .prepare('INSERT INTO _migrations (name, checksum, applied_at) VALUES (?, ?, ?)')
        .run(file, checksum, Date.now());
    });
    apply();
  }
}

export function seedLocalNode(db: DB): void {
  db.insert(nodes)
    .values({ id: 'local', name: '本机', kind: 'local', createdAt: Date.now() })
    .onConflictDoNothing()
    .run();
}
