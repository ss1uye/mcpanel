import crypto from 'node:crypto';
import { count, desc, eq } from 'drizzle-orm';
import type { AuditEntry, Paginated } from '@mcpanel/shared';
import type { Logger } from 'pino';
import type { DB } from '../db/client';
import { auditLogs } from '../db/schema';

const SENSITIVE_SUFFIXES = ['password', 'token', 'secret'] as const;

const SENSITIVE_KEYS = new Set(
  [
    'password',
    'passwordHash',
    'currentPassword',
    'newPassword',
    'confirmPassword',
    'token',
    'accessToken',
    'refreshToken',
    'session',
    'sessionToken',
    'csrf',
    'csrfToken',
    'secret',
    'clientSecret',
    'apiKey',
    'accessKey',
    'privateKey',
    'authorization',
    'cookie',
    'setCookie',
    'credential',
    'credentials',
  ].map(normalizeKey),
);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_. ]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEYS.has(normalized) || SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

export function sanitizeDetail(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => sanitizeDetail(item, depth + 1));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!isSensitiveKey(key)) result[key] = sanitizeDetail(entry, depth + 1);
    }
    return result;
  }
  return value;
}

export interface AuditInput {
  userId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  detail?: Record<string, unknown>;
  ip?: string | null;
}

export class AuditService {
  constructor(
    private readonly db: DB,
    private readonly log?: Logger,
  ) {}

  record(input: AuditInput): void {
    try {
      const detailJson = JSON.stringify(sanitizeDetail(input.detail ?? {}));
      this.db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        userId: input.userId ?? null,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        detailJson: detailJson.length > 8000 ? JSON.stringify({ truncated: true }) : detailJson,
        ip: input.ip ?? null,
        createdAt: Date.now(),
      }).run();
    } catch (error) {
      if (this.log) {
        this.log.error({ err: error }, 'failed to write audit log');
      } else {
        console.error('[audit] failed to write audit log', error);
      }
    }
  }

  list(query: { page: number; pageSize: number; action?: string }): Paginated<AuditEntry> {
    const page = clampInteger(query.page, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = clampInteger(query.pageSize, 1, 100);
    const where = query.action ? eq(auditLogs.action, query.action) : undefined;
    const total = this.db.select({ value: count() }).from(auditLogs).where(where).get()?.value ?? 0;
    const rows = this.db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all();
    return {
      total,
      page,
      pageSize,
      items: rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        detail: parseDetail(row.detailJson),
        ip: row.ip,
        createdAt: new Date(row.createdAt).toISOString(),
      })),
    };
  }
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const integer = Math.trunc(value);
  return Math.min(max, Math.max(min, integer));
}

function parseDetail(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
