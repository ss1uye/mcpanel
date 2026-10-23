import crypto from 'node:crypto';
import { and, eq, gt, lte, ne } from 'drizzle-orm';
import { SESSION_TTL_MS } from '@mcpanel/shared';
import type { DB } from '../db/client';
import { sessions, users } from '../db/schema';

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface SessionUser {
  id: string;
  username: string;
  role: 'admin';
}

export interface ResolvedSession {
  session: { id: string; expiresAt: number };
  user: SessionUser;
}

export class SessionService {
  constructor(private readonly db: DB) {}

  create(userId: string, ip: string | null, userAgent: string | null): { token: string; expiresAt: number } {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAt = now + SESSION_TTL_MS;
    this.db.insert(sessions).values({
      id: crypto.randomUUID(),
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      createdAt: now,
      ip,
      userAgent,
    }).run();
    return { token, expiresAt };
  }

  resolve(token: string): ResolvedSession | null {
    return (
      this.db
        .select({
          session: { id: sessions.id, expiresAt: sessions.expiresAt },
          user: { id: users.id, username: users.username, role: users.role },
        })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, Date.now())))
        .get() ?? null
    );
  }

  delete(token: string): void {
    this.db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token))).run();
  }

  deleteOtherSessions(userId: string, keepToken: string): void {
    this.db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.tokenHash, hashToken(keepToken))))
      .run();
  }

  cleanupExpired(): number {
    return this.db.delete(sessions).where(lte(sessions.expiresAt, Date.now())).run().changes;
  }
}
