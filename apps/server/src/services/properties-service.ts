import fs from 'node:fs/promises';
import path from 'node:path';

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

export async function loadServerProperties(
  root: string,
): Promise<{ raw: string; parsed: ParsedProperties; mtime: number } | null> {
  try {
    const file = path.join(root, 'server.properties');
    const [raw, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    return { raw, parsed: parseProperties(raw), mtime: stat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
