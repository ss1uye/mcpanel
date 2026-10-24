import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planBackupSources, DEFAULT_EXCLUDES } from '../../src/services/backup-sources';
import { AppError } from '../../src/utils/errors';

const roots: string[] = [];

async function fixtures() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-sources-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'world', 'region'), { recursive: true });
  await fs.writeFile(path.join(root, 'world', 'level.dat'), 'level');
  await fs.writeFile(path.join(root, 'world', 'region', 'r.0.0.mca'), 'region');
  await fs.mkdir(path.join(root, 'world_nether'));
  await fs.writeFile(path.join(root, 'world_nether', 'level.dat'), 'nether');
  await fs.mkdir(path.join(root, 'config'));
  await fs.writeFile(path.join(root, 'config', 'a.yml'), 'a');
  await fs.mkdir(path.join(root, 'mods'));
  await fs.writeFile(path.join(root, 'mods', 'a.jar'), 'jar');
  await fs.mkdir(path.join(root, 'logs'));
  await fs.writeFile(path.join(root, 'logs', 'latest.log'), 'log');
  await fs.mkdir(path.join(root, 'cache'));
  await fs.writeFile(path.join(root, 'cache', 'x'), 'x');
  await fs.mkdir(path.join(root, '.mcpanel-tmp'));
  await fs.writeFile(path.join(root, '.mcpanel-tmp', 'tmp'), 'tmp');
  await fs.writeFile(path.join(root, 'server.properties'), 'motd=hi');
  await fs.writeFile(path.join(root, 'eula.txt'), 'eula=true');
  await fs.writeFile(path.join(root, 'whitelist.json'), '[]');
  await fs.mkdir(path.join(root, 'plugins'));
  await fs.writeFile(path.join(root, 'plugins', 'extra.txt'), 'extra');
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('planBackupSources', () => {
  it('collects world, config and metadata while skipping excluded directories', async () => {
    const root = await fixtures();
    const plan = await planBackupSources(root, {
      levelName: 'world',
      includeMods: false,
      includeConfig: true,
      extraPaths: ['plugins'],
    });
    expect(plan.sources).toEqual(
      expect.arrayContaining(['world', 'world_nether', 'config', 'server.properties', 'eula.txt', 'whitelist.json', 'plugins']),
    );
    expect(plan.sources).not.toContain('logs');
    expect(plan.sources).not.toContain('cache');
    expect(plan.sources).not.toContain('.mcpanel-tmp');
    expect(plan.sources).not.toContain('mods');
    expect(plan.fileCount).toBeGreaterThanOrEqual(8);
    expect(plan.totalBytes).toBeGreaterThan(0);
  });

  it('includes mods only when asked and skips missing optional paths', async () => {
    const root = await fixtures();
    const plan = await planBackupSources(root, {
      levelName: 'world',
      includeMods: true,
      includeConfig: false,
      extraPaths: ['missing', 'plugins/extra.txt'],
    });
    expect(plan.sources).toContain('mods');
    expect(plan.sources).not.toContain('config');
    expect(plan.skippedMissing).toContain('missing');
    expect(plan.skippedMissing).not.toContain('world');
  });

  it('rejects when there is nothing to back up', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-empty-'));
    roots.push(root);
    await expect(
      planBackupSources(root, { levelName: 'world', includeMods: false, includeConfig: false, extraPaths: [] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(DEFAULT_EXCLUDES).toContain('logs');
  });

  it('refuses extra paths that escape the instance root', async () => {
    const root = await fixtures();
    await expect(
      planBackupSources(root, { levelName: 'world', includeMods: false, includeConfig: false, extraPaths: ['../outside'] }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
