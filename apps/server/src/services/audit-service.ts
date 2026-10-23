import crypto from 'node:crypto';
import { count, desc, eq } from 'drizzle-orm';
import type { AuditEntry, Paginated } from '@mcpanel/shared';
import type { Logger } from 'pino';
import type { DB } from '../db/client';
import { auditLogs } from '../db/schema';

const SENSITIVE_KEY = /pass(word)?|token|secret/i;

export function sanitizeDetail(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => sanitizeDetail(item, depth + 1));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!SENSITIVE_KEY.test(key)) result[key] = sanitizeDetail(entry, depth + 1);
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
      this.log?.error({ err: error }, 'failed to write audit log');
    }
  }

  list(query: { page: number; pageSize: number; action?: string }): Paginated<AuditEntry> {
    const where = query.action ? eq(auditLogs.action, query.action) : undefined;
    const total = this.db.select({ value: count() }).from(auditLogs).where(where).get()?.value ?? 0;
    const rows = this.db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .all();
    return {
      total,
      page: query.page,
      pageSize: query.pageSize,
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

function parseDetail(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
