import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeBackupArchive } from '../../src/services/backup-archive';
import { extractZipSafe } from '../../src/utils/zip-extract';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('writeBackupArchive', () => {
  it('writes manifest first and includes sources without excluded directories', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-archive-'));
    dirs.push(dir);
    const root = path.join(dir, 'server');
    await fs.mkdir(path.join(root, 'world'), { recursive: true });
    await fs.writeFile(path.join(root, 'world', 'level.dat'), 'level');
    await fs.mkdir(path.join(root, 'logs'));
    await fs.writeFile(path.join(root, 'logs', 'latest.log'), 'log');
    await fs.writeFile(path.join(root, 'server.properties'), 'motd=hi');

    const archive = path.join(dir, 'backup.zip');
    const manifest = {
      schemaVersion: 1 as const,
      panelVersion: '0.1.0',
      instanceName: '生存服',
      createdAt: '2026-10-24T00:00:00.000Z',
      sources: ['world', 'server.properties'],
      fileCount: 2,
      totalBytes: 12,
    };
    const progress: number[] = [];
    const bytes = await writeBackupArchive({
      root,
      sources: ['world', 'server.properties', 'logs'],
      destination: archive,
      manifest,
      onProgress: (value) => progress.push(value),
    });
    expect(bytes).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe(1);

    const out = path.join(dir, 'out');
    await extractZipSafe(archive, out);
    const written = JSON.parse(await fs.readFile(path.join(out, 'manifest.json'), 'utf8')) as { schemaVersion: number };
    expect(written).toMatchObject({ schemaVersion: 1, instanceName: '生存服' });
    expect(await fs.readFile(path.join(out, 'world', 'level.dat'), 'utf8')).toBe('level');
    expect(await fs.readFile(path.join(out, 'server.properties'), 'utf8')).toBe('motd=hi');
    await expect(fs.stat(path.join(out, 'logs', 'latest.log'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
