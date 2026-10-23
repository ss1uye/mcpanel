import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { sessions, users } from '../../src/db/schema';
import { SessionService, hashToken } from '../../src/auth/session';
import { createTestDb, type TestDb } from '../helpers/db';

let ctx: TestDb;

function setup() {
  ctx = createTestDb();
  const userId = randomUUID();
  ctx.db.insert(users).values({
    id: userId,
    username: 'admin',
    passwordHash: '$argon2id$placeholder',
    role: 'admin',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }).run();
  return { userId, service: new SessionService(ctx.db) };
}

afterEach(() => ctx?.close());

describe('SessionService', () => {
  it('creates a token, stores only its hash and resolves the user', () => {
    const { userId, service } = setup();
    const { token } = service.create(userId, '127.0.0.1', 'vitest');
    expect(service.resolve(token)?.user.id).toBe(userId);
    expect(ctx.db.select().from(sessions).get()?.tokenHash).toBe(hashToken(token));
    expect(ctx.db.select().from(sessions).get()?.tokenHash).not.toBe(token);
  });

  it('rejects expired and deleted sessions, removes others and cleans up', () => {
    const { userId, service } = setup();
    const first = service.create(userId, null, null);
    const second = service.create(userId, null, null);
    service.deleteOtherSessions(userId, first.token);
    expect(service.resolve(first.token)).not.toBeNull();
    expect(service.resolve(second.token)).toBeNull();

    service.delete(first.token);
    expect(service.resolve(first.token)).toBeNull();

    const third = service.create(userId, null, null);
    ctx.db.update(sessions).set({ expiresAt: Date.now() - 1 }).run();
    expect(service.cleanupExpired()).toBeGreaterThanOrEqual(1);
    expect(service.resolve(third.token)).toBeNull();
  });
});
