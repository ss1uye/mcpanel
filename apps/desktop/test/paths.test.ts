import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDesktopPaths, resolveLoginItemPath, resolveUserDataDir } from '../src/paths';

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
      resolveUserDataDir({
        appDataDir: 'C:\\Users\\u\\AppData\\Roaming',
        smokeTest: true,
        tempDir: 'C:\\Temp',
        pid: 42,
        runId: 'test',
      }),
    ).toBe(path.join(path.resolve('C:\\Temp'), 'mcpanel-desktop-smoke-42-test'));
  });

  it('falls back to the OS temp directory and returns an absolute smoke path', () => {
    const userDataDir = resolveUserDataDir({
      appDataDir: 'C:\\Users\\u\\AppData\\Roaming',
      smokeTest: true,
      pid: 42,
    });
    expect(path.isAbsolute(userDataDir)).toBe(true);
    expect(userDataDir.startsWith(path.resolve(os.tmpdir()))).toBe(true);
    expect(path.basename(userDataDir)).toMatch(/^mcpanel-desktop-smoke-42-[0-9a-f]{8}$/);
  });

  it('prefers the smoke directory over the portable directory', () => {
    expect(
      resolveUserDataDir({
        portableExecutableDir: 'D:\\MC Panel',
        appDataDir: 'C:\\Users\\u\\AppData\\Roaming',
        smokeTest: true,
        tempDir: 'C:\\Temp',
        pid: 42,
        runId: 'test',
      }),
    ).toBe(path.join(path.resolve('C:\\Temp'), 'mcpanel-desktop-smoke-42-test'));
  });

  it('generates distinct smoke directories for runs without an explicit run id', () => {
    const input = {
      appDataDir: 'C:\\Users\\u\\AppData\\Roaming',
      smokeTest: true,
      tempDir: 'C:\\Temp',
      pid: 42,
    };
    expect(resolveUserDataDir(input)).not.toBe(resolveUserDataDir(input));
  });

  it('uses the portable executable for the login item when present', () => {
    expect(
      resolveLoginItemPath({ PORTABLE_EXECUTABLE_FILE: 'D:\\MC Panel.exe' }, 'C:\\Temp\\electron.exe'),
    ).toBe('D:\\MC Panel.exe');
    expect(resolveLoginItemPath({}, 'C:\\Program Files\\MC Panel\\MC Panel.exe')).toBe(
      'C:\\Program Files\\MC Panel\\MC Panel.exe',
    );
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
