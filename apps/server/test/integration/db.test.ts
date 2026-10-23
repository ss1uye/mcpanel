import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations, seedLocalNode } from '../../src/db/migrate';
import { nodes, schedules } from '../../src/db/schema';
import { createTestDb, migrationsDir, type TestDb } from '../helpers/db';
import { insertInstance } from '../helpers/factory';

let ctx: TestDb;
const opened: TestDb[] = [];

function db(): TestDb {
  ctx = createTestDb();
  opened.push(ctx);
  return ctx;
}

afterEach(() => {
  for (const item of opened.splice(0)) item.close();
});

const tables = [
  'users',
  'sessions',
  'nodes',
  'instances',
  'schedules',
  'schedule_runs',
  'backups',
  'audit_logs',
  'settings',
] as const;

const namedUniqueIndexes = [
  'users_username_unique',
  'sessions_token_hash_unique',
  'instances_name_unique',
  'instances_root_unique',
  'backups_instance_filename_unique',
] as const;

describe('database', () => {
  it('applies migrations once, enables pragmas and seeds the local node once', () => {
    const { db: orm, sqlite } = db();
    expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(orm.select().from(nodes).all()).toEqual([
      expect.objectContaining({ id: 'local', name: '本机', kind: 'local' }),
    ]);

    expect(() => runMigrations(sqlite, migrationsDir)).not.toThrow();
    seedLocalNode(orm);
    seedLocalNode(orm);

    expect(orm.select().from(nodes).all()).toHaveLength(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM _migrations').get()).toEqual({ count: 1 });
  });

  it('enforces case-insensitive instance names and unique root keys', () => {
    const { db: orm } = db();
    insertInstance(orm, { name: 'Survival', rootPath: 'C:\\servers\\a', rootPathKey: 'c:/servers/a' });
    expect(() => insertInstance(orm, { name: 'survival', rootPath: 'C:\\servers\\b', rootPathKey: 'c:/servers/b' })).toThrow();
    expect(() => insertInstance(orm, { name: 'Other', rootPath: 'C:\\servers\\a', rootPathKey: 'c:/servers/a' })).toThrow();
  });

  it('cascades schedules when an instance is deleted', () => {
    const { db: orm } = db();
    const instanceId = insertInstance(orm, { name: 'Cascade' });
    orm
      .insert(schedules)
      .values({
        id: 'schedule-1',
        instanceId,
        name: 'daily backup',
        cron: '0 4 * * *',
        timezone: 'Asia/Shanghai',
        actionType: 'backup',
        payloadJson: '{}',
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    orm.run(sql`DELETE FROM instances WHERE id = ${instanceId}`);
    expect(orm.select().from(schedules).all()).toHaveLength(0);
  });

  it('rejects NULL primary keys at the SQL layer', () => {
    const { sqlite } = db();
    const insertUser = sqlite.prepare(
      'INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (NULL, ?, ?, ?, ?, ?)',
    );
    expect(() => insertUser.run('admin', 'hash', 'admin', 0, 0)).toThrow(/NOT NULL constraint failed: users\.id/);

    const insertSetting = sqlite.prepare('INSERT INTO settings (key, value, updated_at) VALUES (NULL, ?, ?)');
    expect(() => insertSetting.run('value', 0)).toThrow(/NOT NULL constraint failed: settings\.key/);
  });

  it('declares every primary key column as NOT NULL', () => {
    const { sqlite } = db();
    for (const table of tables) {
      const columns = sqlite.pragma(`table_info(${table})`) as Array<{ name: string; notnull: number; pk: number }>;
      const primaryKeys = columns.filter((column) => column.pk > 0);
      expect(primaryKeys, table).toHaveLength(1);
      expect(primaryKeys[0]?.notnull, `${table}.${primaryKeys[0]?.name}`).toBe(1);
    }
  });

  it('uses NOCASE collation and named unique indexes', () => {
    const { sqlite } = db();
    const definitions = new Map(
      (
        sqlite.prepare('SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL').all() as Array<{
          name: string;
          sql: string;
        }>
      ).map((row) => [row.name, row.sql]),
    );

    expect(definitions.get('users')).toContain('COLLATE NOCASE');
    expect(definitions.get('instances')).toContain('COLLATE NOCASE');

    for (const index of namedUniqueIndexes) {
      expect(definitions.get(index), index).toMatch(/^CREATE UNIQUE INDEX/);
    }

    const indexOwners: Array<[string, string]> = [
      ['users', 'users_username_unique'],
      ['sessions', 'sessions_token_hash_unique'],
      ['instances', 'instances_name_unique'],
      ['instances', 'instances_root_unique'],
      ['backups', 'backups_instance_filename_unique'],
    ];
    for (const [table, index] of indexOwners) {
      const indexes = sqlite.pragma(`index_list(${table})`) as Array<{ name: string; unique: number }>;
      expect(indexes.find((row) => row.name === index)?.unique, `${table}.${index}`).toBe(1);
    }
  });

  it('rejects CHECK constraint violations', () => {
    const { db: orm } = db();
    expect(() => insertInstance(orm, { name: 'Bad timeout', stopTimeoutSec: 5 })).toThrow(/CHECK constraint failed/);
  });
});
