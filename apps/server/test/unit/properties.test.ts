import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearServerPropertiesCache,
  loadServerProperties,
  MAX_PROPERTIES_FILE_BYTES,
  parsePort,
  parseProperties,
  propertyValue,
} from '../../src/services/properties-service';

const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-properties-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('properties', () => {
  it('preserves comments, order, duplicates and CRLF', () => {
    const parsed = parseProperties('# comment\r\nmotd=Hello\r\nserver-port=25565\r\nmotd=World\r\n\r\n');
    expect(parsed.eol).toBe('\r\n');
    expect(parsed.entries.map((entry) => entry.key)).toEqual(['motd', 'server-port', 'motd']);
    expect(parsed.duplicates).toEqual(['motd']);
    expect(propertyValue(parsed, 'motd')).toBe('World');
    expect(propertyValue(parsed, 'missing', 'fallback')).toBe('fallback');
  });

  it('ignores blank lines and comments', () => {
    expect(parseProperties('! comment\n\nlevel-name=world\n').entries).toEqual([{ key: 'level-name', value: 'world', line: 3 }]);
  });

  it('parses only decimal ports in range 1-65535', () => {
    expect(parsePort('25565', 1)).toBe(25565);
    expect(parsePort('1', 1)).toBe(1);
    expect(parsePort('65535', 1)).toBe(65535);
    expect(parsePort('0x10', 25565)).toBe(25565);
    expect(parsePort('25565.5', 25565)).toBe(25565);
    expect(parsePort('0', 25565)).toBe(25565);
    expect(parsePort('65536', 25565)).toBe(25565);
    expect(parsePort('70000', 25575)).toBe(25575);
    expect(parsePort('', 25565)).toBe(25565);
  });

  it('reuses the parsed file until its metadata changes', async () => {
    const root = await temp();
    const file = path.join(root, 'server.properties');
    await fs.writeFile(file, 'level-name=world\n');

    const first = await loadServerProperties(root);
    expect(propertyValue(first?.parsed ?? null, 'level-name')).toBe('world');

    const read = vi.spyOn(fs, 'readFile');
    try {
      const cached = await loadServerProperties(root);
      expect(propertyValue(cached?.parsed ?? null, 'level-name')).toBe('world');
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }

    await fs.writeFile(file, 'level-name=nether\n');
    const updated = await loadServerProperties(root);
    expect(propertyValue(updated?.parsed ?? null, 'level-name')).toBe('nether');
  });

  it('re-reads after the panel invalidates the cache', async () => {
    const root = await temp();
    await fs.writeFile(path.join(root, 'server.properties'), 'level-name=world\n');
    await loadServerProperties(root);

    const read = vi.spyOn(fs, 'readFile');
    try {
      clearServerPropertiesCache();
      await loadServerProperties(root);
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
    }
  });

  it('returns null when server.properties is missing', async () => {
    await expect(loadServerProperties(await temp())).resolves.toBeNull();
  });

  it('rejects a directory named server.properties', async () => {
    const root = await temp();
    await fs.mkdir(path.join(root, 'server.properties'));
    await expect(loadServerProperties(root)).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });
  });

  it('rejects server.properties larger than 1 MB', async () => {
    const root = await temp();
    await fs.writeFile(path.join(root, 'server.properties'), 'x'.repeat(MAX_PROPERTIES_FILE_BYTES + 1));
    await expect(loadServerProperties(root)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('rejects a symlinked server.properties', async (context) => {
    const root = await temp();
    const outside = await temp();
    const secret = path.join(outside, 'server.properties');
    await fs.writeFile(secret, 'level-name=leaked\n');
    try {
      await fs.symlink(secret, path.join(root, 'server.properties'), 'file');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') context.skip(`file symlinks unavailable: ${code}`);
      throw error;
    }
    await expect(loadServerProperties(root)).rejects.toMatchObject({ code: 'SYMLINK_NOT_ALLOWED' });
  });
});
