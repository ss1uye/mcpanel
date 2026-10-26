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
}

export function resolveUserDataDir(input: UserDataInput): string {
  if (input.smokeTest) {
    return path.join(input.tempDir ?? '', `mcpanel-desktop-smoke-${input.pid ?? process.pid}`);
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
