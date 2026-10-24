import { AppError } from '../utils/errors';

const INT_RULES: Record<string, [number, number]> = {
  'server-port': [1, 65535],
  'rcon.port': [1, 65535],
  'query.port': [1, 65535],
  'max-players': [1, 10000],
  'view-distance': [2, 32],
  'simulation-distance': [2, 32],
  'spawn-protection': [0, 1000],
  'op-permission-level': [1, 4],
  'entity-broadcast-range-percentage': [10, 1000],
  'max-tick-time': [-1, 600000],
};

const BOOL_KEYS = new Set([
  'online-mode',
  'white-list',
  'enforce-whitelist',
  'hardcore',
  'pvp',
  'allow-flight',
  'force-gamemode',
  'enable-rcon',
  'enable-query',
  'allow-nether',
  'enable-command-block',
]);

const ENUM_RULES: Record<string, readonly string[]> = {
  gamemode: ['survival', 'creative', 'adventure', 'spectator'],
  difficulty: ['peaceful', 'easy', 'normal', 'hard'],
};

export function validatePropertyChanges(changes: Record<string, string>): void {
  for (const [key, value] of Object.entries(changes)) {
    if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) {
      throw new AppError('VALIDATION_ERROR', '键值不能包含换行', { field: key });
    }
    if (BOOL_KEYS.has(key) && value !== 'true' && value !== 'false') {
      throw new AppError('VALIDATION_ERROR', `${key} 只能是 true 或 false`, { field: key });
    }
    const range = INT_RULES[key];
    if (range) {
      const parsed = Number(value);
      if (!/^-?\d+$/.test(value) || !Number.isInteger(parsed) || parsed < range[0] || parsed > range[1]) {
        throw new AppError('VALIDATION_ERROR', `${key} 必须在 ${range[0]} 到 ${range[1]} 之间`, { field: key });
      }
    }
    const allowed = ENUM_RULES[key];
    if (allowed && !allowed.includes(value)) {
      throw new AppError('VALIDATION_ERROR', `${key} 取值不合法`, { field: key });
    }
  }
}

export function patchProperties(raw: string, changes: Record<string, string>): string {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = raw.endsWith('\n');
  const lines = raw.split(/\r?\n/);
  if (hadTrailingNewline) lines.pop();

  const updates = new Map(Object.entries(changes));
  const seen = new Set<string>();
  const next = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return line;
    const separator = trimmed.indexOf('=');
    if (separator < 0) return line;
    const key = trimmed.slice(0, separator).trim();
    if (!updates.has(key)) return line;
    seen.add(key);
    return `${key}=${updates.get(key) ?? ''}`;
  });

  let appended = false;
  for (const [key, value] of updates) {
    if (seen.has(key)) continue;
    next.push(`${key}=${value}`);
    appended = true;
  }
  const body = next.join(eol);
  return hadTrailingNewline || appended ? `${body}${eol}` : body;
}

export function patchEula(raw: string | null): string {
  if (raw === null) return 'eula=true\n';
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = raw.endsWith('\n');
  const lines = raw.split(/\r?\n/);
  if (hadTrailingNewline) lines.pop();
  let found = false;
  const next = lines.map((line) => {
    const trimmed = line.trim();
    const separator = trimmed.indexOf('=');
    if (separator < 0) return line;
    const key = trimmed.slice(0, separator).trim();
    if (key !== 'eula' && key !== '_eula') return line;
    found = true;
    return `${key}=true`;
  });
  if (!found) next.push('eula=true');
  return `${next.join(eol)}${eol}`;
}
