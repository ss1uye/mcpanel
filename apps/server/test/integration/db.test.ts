import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { nodes, schedules } from '../../src/db/schema';
import { createTestDb, type TestDb } from '../helpers/db';
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

describe('database', () => {
  it('applies migrations, enables pragmas and seeds the local node once', () => {
    const { db: orm, sqlite } = db();
    expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(orm.select().from(nodes).all()).toEqual([
      expect.objectContaining({ id: 'local', name: '本机', kind: 'local' }),
    ]);

    const again = createTestDb();
    opened.push(again);
    expect(again.db.select().from(nodes).all()).toHaveLength(1);
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
});
