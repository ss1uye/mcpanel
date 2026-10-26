import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDesktopPaths, resolveUserDataDir } from '../src/paths';

describe('desktop paths', () => {
  it('uses the portable data directory next to the exe', () => {
    expect(
      resolveUserDataDir({ portableExecutableDir: 'D:\\MC Panel', appDataDir: 'C:\\Users\\u\\AppData\\Roaming' }),
    ).toBe(path.join('D:\\MC Panel', 'mcpanel-data'));
  });

  it('uses %APPDATA%\\MC Panel for the installed app', () => {
    expect(resolveUserDataDir({ appDataDir: 'C:\\Users\\u\\AppData\\Roaming' })).toBe(
      path.join('C:\\Users\\u\\AppData\\Roaming', 'MC Panel'),
    );
  });

  it('uses a unique temp directory in smoke mode', () => {
    expect(
      resolveUserDataDir({ appDataDir: 'C:\\Users\\u\\AppData\\Roaming', smokeTest: true, tempDir: 'C:\\Temp', pid: 42 }),
    ).toBe(path.join('C:\\Temp', 'mcpanel-desktop-smoke-42'));
  });

  it('derives data, preferences, runtime and log paths', () => {
    const paths = resolveDesktopPaths('C:\\Users\\u\\AppData\\Roaming\\MC Panel');
    expect(paths.dataDir).toBe(path.join('C:\\Users\\u\\AppData\\Roaming\\MC Panel', 'data'));
    expect(paths.preferencesFile).toBe(path.join('C:\\Users\\u\\AppData\\Roaming\\MC Panel', 'desktop.json'));
    expect(paths.runtimeFile).toBe(path.join('C:\\Users\\u\\AppData\\Roaming\\MC Panel', 'runtime.json'));
    expect(paths.desktopLogFile).toBe(
      path.join('C:\\Users\\u\\AppData\\Roaming\\MC Panel', 'data', 'logs', 'desktop.log'),
    );
  });
});
