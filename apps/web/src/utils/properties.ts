export interface WebPropertyEntry {
  key: string;
  value: string;
}

export function parsePropertiesText(raw: string): { entries: WebPropertyEntry[]; duplicates: string[] } {
  const entries: WebPropertyEntry[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!key) continue;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
    entries.push({ key, value: trimmed.slice(separator + 1).trim() });
  }
  return { entries, duplicates: [...duplicates] };
}

export function lastValue(entries: WebPropertyEntry[], key: string): string | undefined {
  let value: string | undefined;
  for (const entry of entries) if (entry.key === key) value = entry.value;
  return value;
}

export function diffProperties(before: string, after: string): Record<string, string> {
  const oldEntries = parsePropertiesText(before).entries;
  const newEntries = parsePropertiesText(after).entries;
  const changes: Record<string, string> = {};
  for (const key of new Set(oldEntries.map((entry) => entry.key))) {
    const previous = lastValue(oldEntries, key);
    const next = lastValue(newEntries, key);
    if (next !== undefined && next !== previous) changes[key] = next;
  }
  return changes;
}
