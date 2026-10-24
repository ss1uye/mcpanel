import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  ERROR_HTTP_STATUS,
  WS_CHANNEL_PATTERN,
  consoleCommandSchema,
  createInstanceSchema,
  markStoppedSchema,
  setupSchema,
} from '../src/index';
import { playerActionSchema } from '../src/schemas/players';
import { filePathSchema, saveFileSchema, renameSchema } from '../src/schemas/files';
import { panelSettingsSchema } from '../src/schemas/settings';
import { createScheduleSchema, updateScheduleSchema, restoreBackupSchema } from '../src/schemas/automation';

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
    expect(WS_CHANNEL_PATTERN.test('instance:0b9e3a2e-8a41-4f7e-9a8e-1f2d3c4b5a69:console')).toBe(true);
    expect(WS_CHANNEL_PATTERN.test('instance:x:console')).toBe(false);
    expect(WS_CHANNEL_PATTERN.test('system:metrics')).toBe(true);
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

describe('phase 2 schemas', () => {
  it('accepts only whitelisted player actions with sanitized reasons', () => {
    expect(playerActionSchema.parse({ action: 'kick', player: 'Steve', reason: '挂机\n刷屏' })).toEqual({
      action: 'kick',
      player: 'Steve',
      reason: '挂机 刷屏',
    });
    expect(playerActionSchema.parse({ action: 'gamemode', player: 'Alex', mode: 'creative' })).toMatchObject({
      mode: 'creative',
    });
    expect(() => playerActionSchema.parse({ action: 'op', player: 'bad name' })).toThrow();
    expect(() => playerActionSchema.parse({ action: 'say_all', message: 'x' })).toThrow();
    expect(playerActionSchema.parse({ action: 'broadcast', message: '维护 5 分钟' })).toEqual({
      action: 'broadcast',
      message: '维护 5 分钟',
    });
  });

  it('defaults file paths to the instance root and rejects traversal', () => {
    expect(filePathSchema.parse(undefined)).toBe('/');
    expect(filePathSchema.parse('/mods')).toBe('/mods');
    expect(() => filePathSchema.parse('../etc')).toThrow();
    expect(() => filePathSchema.parse('a/../../b')).toThrow();
    expect(() => filePathSchema.parse('/a\0b')).toThrow();
    expect(saveFileSchema.parse({ path: '/ops.json', content: '[]', expectedMtime: 1 })).toMatchObject({
      expectedMtime: 1,
    });
    expect(() => renameSchema.parse({ path: '/a.txt', newName: '../b.txt' })).toThrow();
    expect(() => renameSchema.parse({ path: '/a.txt', newName: 'b/c.txt' })).toThrow();
  });

  it('validates panel settings', () => {
    expect(
      panelSettingsSchema.parse({ panelName: '我的面板', defaultTimezone: 'Asia/Shanghai', auditRetentionDays: 30 }),
    ).toMatchObject({ auditRetentionDays: 30 });
    expect(() => panelSettingsSchema.partial().parse({ defaultTimezone: 'Not/AZone' })).toThrow();
    expect(() => panelSettingsSchema.partial().parse({ auditRetentionDays: 0 })).toThrow();
  });
});

describe('phase 3 schemas', () => {
  it('requires a payload for command and broadcast schedules', () => {
    expect(() =>
      createScheduleSchema.parse({ name: '每日备份', cron: '0 4 * * *', timezone: 'Asia/Shanghai', actionType: 'backup' }),
    ).not.toThrow();
    expect(() =>
      createScheduleSchema.parse({ name: '广播', cron: '0 9 * * *', timezone: 'Asia/Shanghai', actionType: 'broadcast' }),
    ).toThrow();
    expect(
      createScheduleSchema.parse({
        name: '广播',
        cron: '0 9 * * *',
        timezone: 'Asia/Shanghai',
        actionType: 'broadcast',
        message: '早上好',
      }),
    ).toMatchObject({ message: '早上好', enabled: true });
    expect(() =>
      createScheduleSchema.parse({ name: '命令', cron: '*/5 * * * *', timezone: 'Asia/Shanghai', actionType: 'command' }),
    ).toThrow();
  });

  it('validates partial schedule updates and restore confirmation', () => {
    expect(updateScheduleSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(() => updateScheduleSchema.parse({})).toThrow();
    expect(() => restoreBackupSchema.parse({})).toThrow();
    expect(restoreBackupSchema.parse({ confirm: true })).toEqual({ confirm: true });
  });
});
