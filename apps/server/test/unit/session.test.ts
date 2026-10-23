import { randomUUID } from 'node:crypto';
import { SESSION_TTL_MS } from '@mcpanel/shared';
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
  it('creates a 43-char base64url token with a roughly 7 day TTL and stores only its hash', () => {
    const { userId, service } = setup();
    const before = Date.now();
    const { token, expiresAt } = service.create(userId, '127.0.0.1', 'vitest');
    const after = Date.now();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(SESSION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(expiresAt - before).toBeGreaterThanOrEqual(SESSION_TTL_MS);
    expect(expiresAt - after).toBeLessThanOrEqual(SESSION_TTL_MS);

    expect(ctx.db.select().from(sessions).get()?.tokenHash).toBe(hashToken(token));
    expect(ctx.db.select().from(sessions).get()?.tokenHash).not.toBe(token);
  });

  it('resolves only the projected session and user fields', () => {
    const { userId, service } = setup();
    const { token, expiresAt } = service.create(userId, null, null);
    const stored = ctx.db.select().from(sessions).get();

    const resolved = service.resolve(token);
    expect(resolved).not.toBeNull();
    expect(resolved?.session).toEqual({ id: stored?.id, expiresAt });
    expect(resolved?.user).toEqual({ id: userId, username: 'admin', role: 'admin' });
    expect(Object.keys(resolved?.session ?? {}).sort()).toEqual(['expiresAt', 'id']);
    expect(Object.keys(resolved?.user ?? {}).sort()).toEqual(['id', 'role', 'username']);
    expect(resolved?.session).not.toHaveProperty('tokenHash');
    expect(resolved?.user).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(resolved)).not.toContain('passwordHash');
    expect(JSON.stringify(resolved)).not.toContain('tokenHash');
  });

  it('rejects expired rows that have not been cleaned up yet', () => {
    const { userId, service } = setup();
    const { token } = service.create(userId, null, null);
    ctx.db.update(sessions).set({ expiresAt: Date.now() - 1 }).run();

    expect(ctx.db.select().from(sessions).all()).toHaveLength(1);
    expect(service.resolve(token)).toBeNull();
    expect(ctx.db.select().from(sessions).all()).toHaveLength(1);

    expect(service.cleanupExpired()).toBe(1);
    expect(ctx.db.select().from(sessions).all()).toHaveLength(0);
  });

  it('rejects deleted and other-session tokens and cleans up', () => {
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
