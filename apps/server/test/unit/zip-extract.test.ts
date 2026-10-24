import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractZipSafe } from '../../src/utils/zip-extract';
import { makeZip } from '../helpers/zip';

const dirs: string[] = [];

async function withZip(files: Record<string, string>, symlinks: string[] = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-zip-'));
  dirs.push(dir);
  const archive = path.join(dir, 'a.zip');
  await fs.writeFile(archive, makeZip(files, symlinks));
  return { archive, out: path.join(dir, 'out') };
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('extractZipSafe', () => {
  it('extracts nested files', async () => {
    const { archive, out } = await withZip({ 'config/a.txt': 'hello', 'b.txt': 'b' });
    const result = await extractZipSafe(archive, out);
    expect(result.entries).toBe(2);
    expect(await fs.readFile(path.join(out, 'config', 'a.txt'), 'utf8')).toBe('hello');
  });

  it('rejects traversal, absolute and symlink entries', async () => {
    const traversal = await withZip({ '../escape.txt': 'x' });
    await expect(extractZipSafe(traversal.archive, traversal.out)).rejects.toMatchObject({ code: 'ZIP_INVALID' });

    const absolute = await withZip({ '/abs.txt': 'x' });
    await expect(extractZipSafe(absolute.archive, absolute.out)).rejects.toMatchObject({ code: 'ZIP_INVALID' });

    const link = await withZip({ link: 'target' }, ['link']);
    await expect(extractZipSafe(link.archive, link.out)).rejects.toMatchObject({ code: 'ZIP_INVALID' });
  });

  it('enforces entry and byte limits', async () => {
    const many = await withZip({ 'a.txt': 'a', 'b.txt': 'b' });
    await expect(extractZipSafe(many.archive, many.out, { maxEntries: 1 })).rejects.toMatchObject({
      code: 'ZIP_INVALID',
    });

    const big = await withZip({ 'big.bin': 'x'.repeat(2048) });
    await expect(extractZipSafe(big.archive, big.out, { maxBytes: 1024 })).rejects.toMatchObject({
      code: 'ZIP_INVALID',
    });
  });

  it('uses resolveTarget for every entry', async () => {
    const { archive, out } = await withZip({ 'a.txt': 'a' });
    const seen: string[] = [];
    await extractZipSafe(archive, out, {
      resolveTarget: async (name) => {
        seen.push(name);
        return path.join(out, ...name.split('/'));
      },
    });
    expect(seen).toEqual(['a.txt']);
  });
});
