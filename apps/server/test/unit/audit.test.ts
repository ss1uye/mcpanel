import { afterEach, describe, expect, it } from 'vitest';
import { AuditService, sanitizeDetail } from '../../src/services/audit-service';
import { createTestDb, type TestDb } from '../helpers/db';

let ctx: TestDb;
afterEach(() => ctx?.close());

describe('AuditService', () => {
  it('removes sensitive keys recursively', () => {
    expect(
      sanitizeDetail({
        password: 'x',
        nested: { rconPassword: 'y', token: 'z', keep: 'ok' },
        list: [{ secret: 's', name: 'Steve' }],
      }),
    ).toEqual({ nested: { keep: 'ok' }, list: [{ name: 'Steve' }] });
  });

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
});
