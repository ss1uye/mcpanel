import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditLogs } from '../../src/db/schema';
import { AuditService, sanitizeDetail } from '../../src/services/audit-service';
import { createTestDb, type TestDb } from '../helpers/db';

let ctx: TestDb;

afterEach(() => {
  vi.restoreAllMocks();
  ctx?.close();
});

function insertAudit(id: string, createdAt: number, action = 'audit.test'): void {
  ctx.db.insert(auditLogs).values({
    id,
    action,
    targetType: 'test',
    detailJson: '{}',
    createdAt,
  }).run();
}

describe('sanitizeDetail', () => {
  it('removes every deny-listed key after normalization', () => {
    expect(
      sanitizeDetail({
        password: 'x',
        password_hash: 'x',
        PasswordHash: 'x',
        current_password: 'x',
        newPassword: 'x',
        confirmPassword: 'x',
        token: 'x',
        access_token: 'x',
        refreshToken: 'x',
        session: 'x',
        sessionToken: 'x',
        csrf: 'x',
        csrf_token: 'x',
        secret: 'x',
        clientSecret: 'x',
        api_key: 'x',
        accessKey: 'x',
        private_key: 'x',
        authorization: 'x',
        cookie: 'x',
        set_cookie: 'x',
        credential: 'x',
        credentials: 'x',
      }),
    ).toEqual({});
  });

  it('removes keys ending in password, token or secret and keeps lookalikes', () => {
    expect(
      sanitizeDetail({
        rconPassword: 'x',
        db_password: 'x',
        xToken: 'x',
        'my-secret': 'x',
        bypass: 'keep',
        compass: 'keep',
        passenger: 'keep',
        tokenCount: 'keep',
      }),
    ).toEqual({ bypass: 'keep', compass: 'keep', passenger: 'keep', tokenCount: 'keep' });
  });

  it('sanitizes nested objects and arrays', () => {
    expect(
      sanitizeDetail({
        password: 'x',
        nested: { rconPassword: 'y', token: 'z', keep: 'ok' },
        list: [{ secret: 's', name: 'Steve' }],
      }),
    ).toEqual({ nested: { keep: 'ok' }, list: [{ name: 'Steve' }] });
  });
});

describe('AuditService', () => {
  it('writes and pages audit entries', () => {
    ctx = createTestDb();
    const service = new AuditService(ctx.db);
    service.record({ action: 'instance.start', targetType: 'instance', targetId: 'i1', detail: { password: 'x' }, ip: '127.0.0.1' });
    service.record({ action: 'instance.stop', targetType: 'instance', targetId: 'i1' });
    const page = service.list({ page: 1, pageSize: 1, action: 'instance.start' });
    expect(page.total).toBe(1);
    expect(page.items[0]?.detail).toEqual({});
    expect(page.items[0]?.ip).toBe('127.0.0.1');
  });

  it('clamps page and pageSize to safe integers', () => {
    ctx = createTestDb();
    const service = new AuditService(ctx.db);
    insertAudit('a', 1000);
    insertAudit('b', 2000);
    insertAudit('c', 3000);

    const low = service.list({ page: 0, pageSize: 0 });
    expect(low.page).toBe(1);
    expect(low.pageSize).toBe(1);
    expect(low.items).toHaveLength(1);

    const high = service.list({ page: 2.9, pageSize: 2.5 });
    expect(high.page).toBe(2);
    expect(high.pageSize).toBe(2);
    expect(high.items).toHaveLength(1);

    const capped = service.list({ page: 1, pageSize: 1000 });
    expect(capped.pageSize).toBe(100);
    expect(capped.items).toHaveLength(3);

    const nan = service.list({ page: Number.NaN, pageSize: Number.NaN });
    expect(nan.page).toBe(1);
    expect(nan.pageSize).toBe(1);
  });

  it('orders by createdAt desc then id desc for stable ties', () => {
    ctx = createTestDb();
    const service = new AuditService(ctx.db);
    insertAudit('b', 5000);
    insertAudit('a', 5000);
    insertAudit('c', 5000);
    insertAudit('older', 1000);

    expect(service.list({ page: 1, pageSize: 10 }).items.map((item) => item.id)).toEqual(['c', 'b', 'a', 'older']);
  });

  it('caps oversized detail at 8000 chars', () => {
    ctx = createTestDb();
    const service = new AuditService(ctx.db);
    service.record({ action: 'test', targetType: 'test', detail: { note: 'x'.repeat(9001) } });

    const page = service.list({ page: 1, pageSize: 10 });
    expect(page.items[0]?.detail).toEqual({ truncated: true });
    expect(ctx.db.select().from(auditLogs).get()?.detailJson).toBe('{"truncated":true}');
  });

  it('logs to console and stays non-throwing when the insert fails', () => {
    ctx = createTestDb();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = new AuditService(ctx.db);

    expect(() => {
      service.record({ action: 'test', targetType: 'test', detail: { big: 1n } });
    }).not.toThrow();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('[audit] failed to write audit log', expect.any(TypeError));
    expect(ctx.db.select().from(auditLogs).all()).toHaveLength(0);
  });
});
