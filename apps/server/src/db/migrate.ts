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
 * - Applied files are immutable; changing or deleting one is detected and aborts
 *   startup. Add a new migration instead.
 */

interface MigrationRow {
  name: string;
  checksum: string;
}

const MIGRATIONS_TABLE = '_migrations';

/**
 * Hash of the normalized migration text. Line endings are folded to LF so a CRLF
 * checkout (e.g. core.autocrlf=true) and an LF checkout agree; the original text
 * is still what gets executed.
 */
export function checksumOf(sqlText: string): string {
  return createHash('sha256')
    .update(sqlText.replace(/\r\n?/g, '\n'), 'utf8')
    .digest('hex');
}

/**
 * Databases created by the old runner have a `_migrations (name, applied_at)`
 * table. That pre-release shape has no upgrade path, so fail with an actionable
 * message instead of SQLite's "no such column: checksum".
 */
function assertMigrationsTableCompatible(sqlite: Database.Database): void {
  const existing = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(MIGRATIONS_TABLE);
  if (existing === undefined) {
    return;
  }

  const columns = sqlite.pragma(`table_info(${MIGRATIONS_TABLE})`) as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'checksum')) {
    throw new Error(
      'The existing _migrations table predates checksum tracking and has no "checksum" column. ' +
        'This pre-release schema change has no automatic upgrade path: back up data/panel.db if ' +
        'you need its contents, then delete data/panel.db and start the panel again.',
    );
  }
}

export function runMigrations(sqlite: Database.Database, migrationsDir: string): void {
  assertMigrationsTableCompatible(sqlite);

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
  const filesOnDisk = new Set(files);

  // Applied migrations are immutable history: deleting or renaming one is drift,
  // not a rollback, and is fixed by restoring the file rather than ignoring it.
  for (const name of applied.keys()) {
    if (!filesOnDisk.has(name)) {
      throw new Error(
        `Migration drift detected: applied migration "${name}" no longer exists in ${migrationsDir}. ` +
          'Restore the applied file (or the database backup it belongs to) and add a new migration ' +
          'for further schema changes.',
      );
    }
  }

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
