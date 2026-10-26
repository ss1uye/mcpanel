import fs from 'node:fs';
import path from 'node:path';

export interface Preferences {
  autoLaunch: boolean;
  minimizeToTray: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = { autoLaunch: false, minimizeToTray: true };

export function loadPreferences(file: string): Preferences {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Preferences> | null;
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_PREFERENCES };
    return {
      autoLaunch: typeof parsed.autoLaunch === 'boolean' ? parsed.autoLaunch : DEFAULT_PREFERENCES.autoLaunch,
      minimizeToTray:
        typeof parsed.minimizeToTray === 'boolean' ? parsed.minimizeToTray : DEFAULT_PREFERENCES.minimizeToTray,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function savePreferences(file: string, preferences: Preferences): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(preferences, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}
