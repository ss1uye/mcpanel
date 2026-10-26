import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importPanelData, isPanelDataDir } from '../src/data-import';

const dirs: string[] = [];
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpanel-desktop-import-'));
  dirs.push(dir);
  return dir;
}
function stagingEntries(target: string): string[] {
  const prefix = `${path.basename(target)}.import-`;
  return fs.readdirSync(path.dirname(target)).filter((entry) => entry.startsWith(prefix));
}
afterEach(() => {
  vi.restoreAllMocks();
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
    expect(stagingEntries(target)).toEqual([]);
  });

  it('imports into an existing but empty target directory', async () => {
    const source = temp();
    fs.writeFileSync(path.join(source, 'panel.db'), 'db');
    fs.mkdirSync(path.join(source, 'logs'));
    fs.writeFileSync(path.join(source, 'logs', 'panel.log'), 'panel');
    const target = temp();

    await importPanelData(source, target);
    expect(fs.readFileSync(path.join(target, 'panel.db'), 'utf8')).toBe('db');
    expect(fs.readFileSync(path.join(target, 'logs', 'panel.log'), 'utf8')).toBe('panel');
    expect(stagingEntries(target)).toEqual([]);
  });

  it('rejects a target directory whose name merely starts with two dots', async () => {
    const source = temp();
    fs.writeFileSync(path.join(source, 'panel.db'), 'db');
    const target = path.join(source, '..data');
    fs.mkdirSync(target);
    await expect(importPanelData(source, target)).rejects.toThrow(/目标目录不能位于源目录内/);
  });

  it('rejects a directory without panel.db', async () => {
    await expect(importPanelData(temp(), path.join(temp(), 'data'))).rejects.toThrow(/panel\.db/);
  });

  it('rejects an already initialized target', async () => {
    const source = temp();
    fs.writeFileSync(path.join(source, 'panel.db'), 'db');
    fs.writeFileSync(path.join(source, 'secret.key'), 'secret');
    const target = temp();
    fs.writeFileSync(path.join(target, 'panel.db'), 'existing');
    await expect(importPanelData(source, target)).rejects.toThrow(/已有面板数据/);
    expect(fs.readFileSync(path.join(target, 'panel.db'), 'utf8')).toBe('existing');
    expect(fs.existsSync(path.join(target, 'secret.key'))).toBe(false);
  });

  it('rejects a target that already holds unrelated data', async () => {
    const source = temp();
    fs.writeFileSync(path.join(source, 'panel.db'), 'db');
    const target = temp();
    fs.mkdirSync(path.join(target, 'instances'));

    await expect(importPanelData(source, target)).rejects.toThrow(/已有数据/);
    expect(fs.existsSync(path.join(target, 'panel.db'))).toBe(false);
    expect(stagingEntries(target)).toEqual([]);
  });

  it('rejects a target path that is a file', async () => {
    const source = temp();
    fs.writeFileSync(path.join(source, 'panel.db'), 'db');
    const target = path.join(temp(), 'data');
    fs.writeFileSync(target, 'not a directory');

    await expect(importPanelData(source, target)).rejects.toThrow(/已有数据/);
    expect(fs.readFileSync(target, 'utf8')).toBe('not a directory');
    expect(stagingEntries(target)).toEqual([]);
  });

  it('rejects a target nested inside the source', async () => {
    const source = temp();
    fs.writeFileSync(path.join(source, 'panel.db'), 'db');
    await expect(importPanelData(source, path.join(source, 'data'))).rejects.toThrow(/不能位于源目录内/);
    expect(fs.existsSync(path.join(source, 'data'))).toBe(false);
  });

  it('rejects the source itself as target', async () => {
    const source = temp();
    fs.writeFileSync(path.join(source, 'panel.db'), 'db');
    await expect(importPanelData(source, source)).rejects.toThrow(/相同/);
  });

  it('rejects a source nested inside the target', async () => {
    const target = temp();
    const source = path.join(target, 'backup');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'panel.db'), 'db');
    await expect(importPanelData(source, target)).rejects.toThrow(/不能位于目标目录内/);
  });

  it('cleans up the staging directory when the copy fails', async () => {
    const source = temp();
    fs.writeFileSync(path.join(source, 'panel.db'), 'db');
    const target = path.join(temp(), 'data');

    vi.spyOn(fsp, 'cp').mockRejectedValueOnce(new Error('boom'));
    await expect(importPanelData(source, target)).rejects.toThrow(/boom/);

    expect(fs.existsSync(target)).toBe(false);
    expect(stagingEntries(target)).toEqual([]);
  });
});
