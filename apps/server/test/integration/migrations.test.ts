import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DbHandle } from '../../src/db/client';
import { checksumOf, runMigrations } from '../../src/db/migrate';
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

  it('treats CRLF, lone CR and LF migration files as the same checksum', () => {
    const lf = 'CREATE TABLE a (id TEXT PRIMARY KEY NOT NULL);\nCREATE TABLE b (id TEXT PRIMARY KEY NOT NULL);\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    const cr = lf.replace(/\n/g, '\r');

    expect(checksumOf(crlf)).toBe(checksumOf(lf));
    expect(checksumOf(cr)).toBe(checksumOf(lf));

    // Apply a CRLF checkout, then verify an LF checkout still matches.
    const dir = writeMigrations({ '0000_eol.sql': crlf });
    const { sqlite } = openTempDb();
    runMigrations(sqlite, dir);

    const stored = sqlite.prepare('SELECT checksum FROM _migrations WHERE name = ?').get('0000_eol.sql') as {
      checksum: string;
    };
    expect(stored.checksum).toBe(checksumOf(lf));

    fs.writeFileSync(path.join(dir, '0000_eol.sql'), lf);
    expect(() => runMigrations(sqlite, dir)).not.toThrow();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM _migrations').get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'b'").get()).toBeDefined();
  });

  it('fails with an actionable error when an old _migrations table has no checksum column', () => {
    const dir = writeMigrations({
      '0000_a.sql': 'CREATE TABLE a (id TEXT PRIMARY KEY NOT NULL);\n',
    });
    const { sqlite } = openTempDb();
    sqlite.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)');
    sqlite.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run('0000_a.sql', Date.now());

    expect(() => runMigrations(sqlite, dir)).toThrow(/checksum[\s\S]*back up data\/panel\.db[\s\S]*delete data\/panel\.db/i);
    // The guard must fire before any migration DDL runs.
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'a'").get()).toBeUndefined();
  });

  it('refuses to continue when an applied migration was deleted from disk', () => {
    const dir = writeMigrations({
      '0000_a.sql': 'CREATE TABLE a (id TEXT PRIMARY KEY NOT NULL);\n',
      '0001_b.sql': 'CREATE TABLE b (id TEXT PRIMARY KEY NOT NULL);\n',
    });
    const { sqlite } = openTempDb();
    runMigrations(sqlite, dir);

    fs.rmSync(path.join(dir, '0001_b.sql'));

    expect(() => runMigrations(sqlite, dir)).toThrow(/0001_b\.sql.*no longer exists/i);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM _migrations').get()).toEqual({ count: 2 });
  });

  it('does not apply pending migrations when an applied migration was modified', () => {
    const dir = writeMigrations({
      '0000_a.sql': 'CREATE TABLE a (id TEXT PRIMARY KEY NOT NULL);\n',
    });
    const { sqlite } = openTempDb();
    runMigrations(sqlite, dir);

    fs.writeFileSync(path.join(dir, '0000_a.sql'), 'CREATE TABLE a (id TEXT PRIMARY KEY NOT NULL, note TEXT);\n');
    fs.writeFileSync(path.join(dir, '0001_b.sql'), 'CREATE TABLE b (id TEXT PRIMARY KEY NOT NULL);\n');

    expect(() => runMigrations(sqlite, dir)).toThrow(/0000_a\.sql.*modified/i);
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'b'").get()).toBeUndefined();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM _migrations').get()).toEqual({ count: 1 });
  });

  it('the drizzle directory contains only numbered SQL migrations and no meta directory', () => {
    const entries = fs.readdirSync(migrationsDir);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries).not.toContain('meta');
    for (const entry of entries) {
      expect(entry).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    }
  });
});
