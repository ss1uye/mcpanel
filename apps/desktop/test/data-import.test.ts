import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importPanelData, isPanelDataDir } from '../src/data-import';

const dirs: string[] = [];
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpanel-desktop-import-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('importPanelData', () => {
  it('copies an existing panel data directory', async () => {
    const source = temp();
    fs.writeFileSync(path.join(source, 'panel.db'), 'db');
    fs.writeFileSync(path.join(source, 'secret.key'), 'secret');
    fs.mkdirSync(path.join(source, 'backups'));
    const target = path.join(temp(), 'data');

    expect(isPanelDataDir(source)).toBe(true);
    await importPanelData(source, target);
    expect(fs.readFileSync(path.join(target, 'panel.db'), 'utf8')).toBe('db');
    expect(fs.readFileSync(path.join(target, 'secret.key'), 'utf8')).toBe('secret');
    expect(fs.statSync(path.join(target, 'backups')).isDirectory()).toBe(true);
  });

  it('imports into an existing data directory without overwriting existing files', async () => {
    const source = temp();
    fs.writeFileSync(path.join(source, 'panel.db'), 'db');
    fs.mkdirSync(path.join(source, 'logs'));
    fs.writeFileSync(path.join(source, 'logs', 'panel.log'), 'panel');
    const target = temp();
    fs.mkdirSync(path.join(target, 'logs'));
    fs.writeFileSync(path.join(target, 'logs', 'desktop.log'), 'desktop');

    await importPanelData(source, target);
    expect(fs.readFileSync(path.join(target, 'panel.db'), 'utf8')).toBe('db');
    expect(fs.readFileSync(path.join(target, 'logs', 'panel.log'), 'utf8')).toBe('panel');
    expect(fs.readFileSync(path.join(target, 'logs', 'desktop.log'), 'utf8')).toBe('desktop');
  });

  it('rejects a directory without panel.db', async () => {
    await expect(importPanelData(temp(), path.join(temp(), 'data'))).rejects.toThrow(/panel\.db/);
  });

  it('rejects an already initialized target', async () => {
    const source = temp();
    fs.writeFileSync(path.join(source, 'panel.db'), 'db');
    const target = temp();
    fs.writeFileSync(path.join(target, 'panel.db'), 'existing');
    await expect(importPanelData(source, target)).rejects.toThrow(/已有面板数据/);
  });
});
