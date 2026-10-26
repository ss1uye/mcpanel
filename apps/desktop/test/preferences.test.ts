import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, loadPreferences, savePreferences } from '../src/preferences';

const dirs: string[] = [];
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpanel-desktop-prefs-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('desktop preferences', () => {
  it('returns defaults for a missing or malformed file', () => {
    const dir = temp();
    expect(loadPreferences(path.join(dir, 'missing.json'))).toEqual(DEFAULT_PREFERENCES);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{oops');
    expect(loadPreferences(path.join(dir, 'bad.json'))).toEqual(DEFAULT_PREFERENCES);
  });

  it('reads booleans and ignores invalid fields', () => {
    const file = path.join(temp(), 'desktop.json');
    fs.writeFileSync(file, JSON.stringify({ autoLaunch: true, minimizeToTray: 'yes' }));
    expect(loadPreferences(file)).toEqual({ autoLaunch: true, minimizeToTray: DEFAULT_PREFERENCES.minimizeToTray });
  });

  it('round-trips values atomically', () => {
    const file = path.join(temp(), 'desktop.json');
    savePreferences(file, { autoLaunch: true, minimizeToTray: false });
    expect(loadPreferences(file)).toEqual({ autoLaunch: true, minimizeToTray: false });
  });
});
