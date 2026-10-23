import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { nodes } from './schema';
import type { DB } from './client';

export function runMigrations(sqlite: Database.Database, migrationsDir: string): void {
  sqlite.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(
    sqlite.prepare('SELECT name FROM _migrations').all().map((row) => (row as { name: string }).name),
  );
  const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sqlText = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const apply = sqlite.transaction(() => {
      sqlite.exec(sqlText);
      sqlite.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(file, Date.now());
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
