import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { resetPassword } from '../../../../scripts/reset-password.mjs';
import { verifyPassword } from '../../src/auth/password';
import { openDatabase, type DbHandle } from '../../src/db/client';
import { runMigrations, seedLocalNode } from '../../src/db/migrate';
import { sessions, users } from '../../src/db/schema';
import { migrationsDir } from '../helpers/db';
import { insertUser } from '../helpers/factory';

let dir: string | undefined;
let handle: DbHandle | undefined;

async function setup() {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-reset-'));
  handle = openDatabase(path.join(dir, 'panel.db'));
  runMigrations(handle.sqlite, migrationsDir);
  seedLocalNode(handle.db);
  return { dbPath: path.join(dir, 'panel.db'), db: handle.db };
}

afterEach(async () => {
  try {
    handle?.sqlite.close();
  } catch {
    // already closed
  }
  handle = undefined;
  if (dir) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
  dir = undefined;
});

describe('reset-password script', () => {
  it('resets the hash and clears sessions', async () => {
    const { dbPath, db } = await setup();
    const id = insertUser(db, 'admin', '$argon2id$placeholder');
    db.insert(sessions)
      .values({
        id: randomUUID(),
        userId: id,
        tokenHash: 'hash',
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        ip: null,
        userAgent: null,
      })
      .run();

    await resetPassword(dbPath, 'admin', 'Brand-New-Password-2026');

    const row = db.select().from(users).all()[0]!;
    expect(await verifyPassword(row.passwordHash, 'Brand-New-Password-2026')).toBe(true);
    expect(db.select().from(sessions).all()).toHaveLength(0);
  });

  it('rejects short passwords and unknown users', async () => {
    const { dbPath, db } = await setup();
    insertUser(db, 'admin');
    await expect(resetPassword(dbPath, 'admin', 'short')).rejects.toThrow(/12/);
    await expect(resetPassword(dbPath, 'ghost', 'Brand-New-Password-2026')).rejects.toThrow(/用户不存在/);
  });
});
