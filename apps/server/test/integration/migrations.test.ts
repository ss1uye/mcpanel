import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { migrationsDir } from '../helpers/db';

const tempDirs: string[] = [];
const handles: DbHandle[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function openTempDb(): DbHandle {
  const dir = tempDir('mcpanel-migrate-db-');
  const handle = openDatabase(path.join(dir, 'panel.db'));
  handles.push(handle);
  return handle;
}

function writeMigrations(files: Record<string, string>): string {
  const dir = tempDir('mcpanel-migrations-');
  for (const [name, sqlText] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), sqlText);
  }
  return dir;
}

afterEach(() => {
  for (const handle of handles.splice(0)) {
    try {
      handle.sqlite.close();
    } catch {
      // The test itself may already have closed the handle.
    }
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('migration runner', () => {
  it('applies files once and records name, checksum and timestamp', () => {
    const dir = writeMigrations({
      '0000_a.sql': 'CREATE TABLE a (id TEXT PRIMARY KEY NOT NULL);\n',
      '0001_b.sql': 'CREATE TABLE b (id TEXT PRIMARY KEY NOT NULL);\n',
    });
    const { sqlite } = openTempDb();

    runMigrations(sqlite, dir);

    const rows = sqlite
      .prepare('SELECT name, checksum, applied_at FROM _migrations ORDER BY name')
      .all() as Array<{ name: string; checksum: string; applied_at: number }>;
    expect(rows.map((row) => row.name)).toEqual(['0000_a.sql', '0001_b.sql']);
    for (const row of rows) {
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(row.applied_at).toEqual(expect.any(Number));
    }

    runMigrations(sqlite, dir);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM _migrations').get()).toEqual({ count: 2 });
  });

  it('refuses to continue when an applied migration file was modified', () => {
    const dir = writeMigrations({
      '0000_a.sql': 'CREATE TABLE a (id TEXT PRIMARY KEY NOT NULL);\n',
      '0001_b.sql': 'CREATE TABLE b (id TEXT PRIMARY KEY NOT NULL);\n',
    });
    const { sqlite } = openTempDb();
    runMigrations(sqlite, dir);

    fs.writeFileSync(path.join(dir, '0001_b.sql'), 'CREATE TABLE b (id TEXT PRIMARY KEY NOT NULL, note TEXT);\n');

    expect(() => runMigrations(sqlite, dir)).toThrow(/0001_b\.sql.*modified/i);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM _migrations').get()).toEqual({ count: 2 });
  });

  it('the drizzle directory contains exactly the hand-written initial migration', () => {
    expect(fs.readdirSync(migrationsDir)).toEqual(['0000_init.sql']);
  });
});
