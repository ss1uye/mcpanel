import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../utils/errors';

export const DEFAULT_EXCLUDES = ['logs', 'crash-reports', 'cache', 'libraries', '.mcpanel-tmp'] as const;
const MAX_EXTRA_PATHS = 20;

export interface BackupSourceOptions {
  levelName: string;
  includeMods: boolean;
  includeConfig: boolean;
  extraPaths: string[];
}

export interface BackupSourcePlan {
  sources: string[];
  files: string[];
  directories: string[];
  fileCount: number;
  totalBytes: number;
  skippedMissing: string[];
}

interface WalkState {
  files: string[];
  directories: string[];
  seenFiles: Set<string>;
  seenDirectories: Set<string>;
  fileCount: number;
  totalBytes: number;
}

function isExcluded(rel: string): boolean {
  return rel
    .split('/')
    .some((segment) => (DEFAULT_EXCLUDES as readonly string[]).includes(segment));
}

function normalizeExtra(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized || normalized.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) {
    throw new AppError('VALIDATION_ERROR', `备份附加路径非法：${value}`);
  }
  if (isExcluded(normalized)) {
    throw new AppError('VALIDATION_ERROR', `备份附加路径不能位于排除目录：${value}`);
  }
  return normalized;
}

async function walk(root: string, rel: string, state: WalkState): Promise<void> {
  const absolute = path.join(root, ...rel.split('/'));
  const stat = await fs.lstat(absolute).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    const entries = await fs.readdir(absolute).catch(() => [] as string[]);
    if (entries.length === 0 && !state.seenDirectories.has(rel)) {
      state.seenDirectories.add(rel);
      state.directories.push(rel);
    }
    for (const entry of entries) {
      const childRel = `${rel}/${entry}`;
      if (isExcluded(childRel)) continue;
      await walk(root, childRel, state);
    }
    return;
  }
  if (stat.isFile() && !state.seenFiles.has(rel)) {
    state.seenFiles.add(rel);
    state.files.push(rel);
    state.fileCount += 1;
    state.totalBytes += stat.size;
  }
}

export async function planBackupSources(root: string, options: BackupSourceOptions): Promise<BackupSourcePlan> {
  if (options.extraPaths.length > MAX_EXTRA_PATHS) {
    throw new AppError('VALIDATION_ERROR', `备份附加路径最多 ${MAX_EXTRA_PATHS} 个`);
  }
  const candidates = [
    options.levelName,
    `${options.levelName}_nether`,
    `${options.levelName}_the_end`,
    'server.properties',
    'eula.txt',
    'whitelist.json',
    'ops.json',
    'banned-players.json',
    'banned-ips.json',
    ...(options.includeConfig ? ['config', 'defaultconfigs'] : []),
    ...(options.includeMods ? ['mods'] : []),
    ...options.extraPaths.map(normalizeExtra),
  ];

  const sources: string[] = [];
  const skippedMissing: string[] = [];
  const seen = new Set<string>();
  const state: WalkState = {
    files: [],
    directories: [],
    seenFiles: new Set(),
    seenDirectories: new Set(),
    fileCount: 0,
    totalBytes: 0,
  };

  for (const candidate of candidates) {
    if (seen.has(candidate) || isExcluded(candidate)) continue;
    seen.add(candidate);
    const absolute = path.join(root, ...candidate.split('/'));
    const stat = await fs.lstat(absolute).catch(() => null);
    if (!stat) {
      skippedMissing.push(candidate);
      continue;
    }
    if (stat.isSymbolicLink()) {
      throw new AppError('SYMLINK_NOT_ALLOWED', `备份源包含符号链接：${candidate}`);
    }
    sources.push(candidate);
    await walk(root, candidate, state);
  }

  if (state.fileCount === 0) {
    throw new AppError('VALIDATION_ERROR', '没有可备份的内容');
  }
  return {
    sources,
    files: state.files,
    directories: state.directories,
    fileCount: state.fileCount,
    totalBytes: state.totalBytes,
    skippedMissing,
  };
}
