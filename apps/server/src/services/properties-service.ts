import fs from 'node:fs/promises';
import path from 'node:path';
import type { PathSandbox } from '../nodes/path-sandbox';
import { AppError } from '../utils/errors';

export const MAX_PROPERTIES_FILE_BYTES = 1024 * 1024;

export interface PropertyEntry {
  key: string;
  value: string;
  line: number;
}

export interface ParsedProperties {
  entries: PropertyEntry[];
  duplicates: string[];
  eol: '\r\n' | '\n';
}

export function parseProperties(raw: string): ParsedProperties {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const entries: PropertyEntry[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  raw.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return;
    const separator = trimmed.indexOf('=');
    if (separator < 0) return;
    const key = trimmed.slice(0, separator).trim();
    if (!key) return;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
    entries.push({ key, value: trimmed.slice(separator + 1).trim(), line: index + 1 });
  });
  return { entries, duplicates: [...duplicates], eol };
}

export function propertyValue(parsed: ParsedProperties | null, key: string, fallback = ''): string {
  if (!parsed) return fallback;
  const matches = parsed.entries.filter((entry) => entry.key === key);
  return matches.length > 0 ? matches[matches.length - 1]!.value : fallback;
}

export function parsePort(value: string, fallback: number): number {
  if (!/^\d+$/.test(value)) return fallback;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : fallback;
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function readRegularFile(file: string, maxBytes: number): Promise<{ raw: string; mtime: number }> {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink()) throw new AppError('SYMLINK_NOT_ALLOWED', '不允许读取符号链接或目录联接');
  if (!stat.isFile()) throw new AppError('UNSUPPORTED_FILE', '目标不是普通文件');
  if (stat.size > maxBytes) throw new AppError('FILE_TOO_LARGE', `文件超过 ${Math.floor(maxBytes / 1024 / 1024)} MB 限制`);
  const raw = await fs.readFile(file, 'utf8');
  return { raw, mtime: stat.mtimeMs };
}

export async function readSandboxedTextFile(
  sandbox: PathSandbox,
  root: string,
  name: string,
  maxBytes = MAX_PROPERTIES_FILE_BYTES,
): Promise<{ raw: string; mtime: number } | null> {
  const file = await sandbox.resolve(root, name);
  try {
    return await readRegularFile(file, maxBytes);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export async function loadServerProperties(
  root: string,
  sandbox?: PathSandbox,
): Promise<{ raw: string; parsed: ParsedProperties; mtime: number } | null> {
  const file = sandbox ? await sandbox.resolve(root, 'server.properties') : path.join(root, 'server.properties');
  try {
    const { raw, mtime } = await readRegularFile(file, MAX_PROPERTIES_FILE_BYTES);
    return { raw, parsed: parseProperties(raw), mtime };
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}
