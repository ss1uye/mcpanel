import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export interface DesktopPaths {
  userDataDir: string;
  dataDir: string;
  preferencesFile: string;
  runtimeFile: string;
  desktopLogFile: string;
}

export interface UserDataInput {
  portableExecutableDir?: string;
  appDataDir: string;
  smokeTest?: boolean;
  tempDir?: string;
  pid?: number;
  runId?: string;
}

export function resolveUserDataDir(input: UserDataInput): string {
  if (input.smokeTest) {
    const base = path.resolve(input.tempDir ?? os.tmpdir());
    const suffix = input.runId ?? randomUUID().slice(0, 8);
    return path.join(base, `mcpanel-desktop-smoke-${input.pid ?? process.pid}-${suffix}`);
  }
  if (input.portableExecutableDir) return path.join(input.portableExecutableDir, 'mcpanel-data');
  return path.join(input.appDataDir, 'MC Panel');
}

export function resolveDesktopPaths(userDataDir: string): DesktopPaths {
  const dataDir = path.join(userDataDir, 'data');
  return {
    userDataDir,
    dataDir,
    preferencesFile: path.join(userDataDir, 'desktop.json'),
    runtimeFile: path.join(userDataDir, 'runtime.json'),
    desktopLogFile: path.join(dataDir, 'logs', 'desktop.log'),
  };
}
