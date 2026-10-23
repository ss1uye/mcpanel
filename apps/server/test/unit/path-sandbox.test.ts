import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PathSandbox, toRootKey } from '../../src/nodes/path-sandbox';

const dirs: string[] = [];

async function temp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-sandbox-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('PathSandbox', () => {
  it('validates a normal directory and computes a stable root key', async () => {
    const dataDir = await temp();
    const root = await temp();
    const result = await new PathSandbox(dataDir).validateRoot(root, []);
    expect(result.realPath).toBe(await fs.realpath(root));
    expect(result.rootKey).toBe(toRootKey(result.realPath));
  });

  it('rejects files, filesystem root and home directory', async () => {
    const dataDir = await temp();
    const sandbox = new PathSandbox(dataDir);
    const file = path.join(dataDir, 'a.txt');
    await fs.writeFile(file, 'x');
    await expect(sandbox.validateRoot(file, [])).rejects.toMatchObject({ code: 'INVALID_ROOT' });
    await expect(sandbox.validateRoot(path.parse(dataDir).root, [])).rejects.toMatchObject({ code: 'INVALID_ROOT' });
    await expect(sandbox.validateRoot(os.homedir(), [])).rejects.toMatchObject({ code: 'INVALID_ROOT' });
  });

  it('rejects overlap with data directory and other instances', async () => {
    const dataDir = await temp();
    const root = await temp();
    const nested = path.join(root, 'nested');
    await fs.mkdir(nested);
    const sandbox = new PathSandbox(dataDir);
    await expect(sandbox.validateRoot(dataDir, [])).rejects.toMatchObject({ code: 'ROOT_OVERLAPS' });
    await expect(sandbox.validateRoot(root, [nested])).rejects.toMatchObject({ code: 'ROOT_OVERLAPS' });
  });

  it('resolves relative paths and rejects traversal', async () => {
    const dataDir = await temp();
    const root = await temp();
    await fs.mkdir(path.join(root, 'config'));
    const sandbox = new PathSandbox(dataDir);
    await expect(sandbox.resolve(root, '/config/x.yml')).resolves.toBe(path.join(root, 'config', 'x.yml'));
    await expect(sandbox.resolve(root, '../outside.txt')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_ROOT' });
    await expect(sandbox.resolve(root, 'a/../../outside.txt')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_ROOT' });
    await expect(sandbox.resolve(root, 'C:\\Windows\\win.ini')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_ROOT' });
  });

  it('rejects symlinked or junctioned paths', async () => {
    const dataDir = await temp();
    const root = await temp();
    const outside = await temp();
    await fs.symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(new PathSandbox(dataDir).resolve(root, 'link/secret.txt')).rejects.toMatchObject({ code: 'SYMLINK_NOT_ALLOWED' });
  });
});
