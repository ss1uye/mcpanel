import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  ERROR_HTTP_STATUS,
  channelPattern,
  consoleCommandSchema,
  createInstanceSchema,
  markStoppedSchema,
  setupSchema,
} from '../src/index';

describe('shared contracts', () => {
  it('rejects a password shorter than 12 characters', () => {
    const result = setupSchema.safeParse({ username: 'admin', password: 'short' });
    expect(result.success).toBe(false);
  });

  it('applies instance defaults', () => {
    const parsed = createInstanceSchema.parse({
      name: '生存服',
      rootPath: 'D:\\servers\\survival',
      startCommand: 'run.bat',
    });
    expect(parsed.stopTimeoutSec).toBe(30);
    expect(parsed.logEncoding).toBe('utf-8');
    expect(parsed.backupKeep).toBe(10);
    expect(parsed.backupIncludeConfig).toBe(true);
    expect(parsed.backupExtraPaths).toEqual([]);
  });

  it('rejects multiline console commands', () => {
    expect(consoleCommandSchema.safeParse({ command: 'say a\nsay b' }).success).toBe(false);
  });

  it('only accepts known channels', () => {
    expect(channelPattern.test('instance:0b9e3a2e-8a41-4f7e-9a8e-1f2d3c4b5a69:console')).toBe(true);
    expect(channelPattern.test('instance:x:console')).toBe(false);
    expect(channelPattern.test('system:metrics')).toBe(true);
  });

  it('requires explicit confirmation for mark-stopped', () => {
    expect(markStoppedSchema.safeParse({}).success).toBe(false);
    expect(markStoppedSchema.safeParse({ confirm: true }).success).toBe(true);
  });

  it('maps every error code to an HTTP status', () => {
    for (const code of API_ERROR_CODES) {
      expect(ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });
});
