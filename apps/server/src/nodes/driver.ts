import type { LogEncoding, ProcessSnapshot, RootValidation, StartSpec } from '@mcpanel/shared';

export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  mtime: string;
  symlink: boolean;
}

export interface TextFile {
  content: string;
  mtime: number;
}

export interface NodeDriver {
  validateRoot(rootPath: string, otherRoots: string[]): Promise<RootValidation>;
  listFiles(root: string, relPath: string): Promise<FileEntry[]>;
  readText(root: string, relPath: string): Promise<TextFile>;
  startProcess(spec: StartSpec): Promise<ProcessSnapshot>;
  stopProcess(instanceId: string, timeoutSec: number): Promise<{ forced: boolean }>;
  killProcessTree(instanceId: string): Promise<void>;
  writeStdin(instanceId: string, line: string): Promise<void>;
  getProcessSnapshot(instanceId: string): ProcessSnapshot | null;
  verifyPid(pid: number, rootPath: string): Promise<boolean>;
  readLogTail(rootPath: string, encoding: LogEncoding, bytes?: number): Promise<string[]>;
}
