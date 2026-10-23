import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalNodeDriver } from '../../src/nodes/local-driver';
import { PathSandbox } from '../../src/nodes/path-sandbox';

const fixture = fileURLToPath(new URL('../fixtures/fake-server.mjs', import.meta.url));
const roots: string[] = [];
const drivers: LocalNodeDriver[] = [];

async function makeRoot(prefix = 'mcpanel-driver-'): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function makeDriver(dataDir: string): LocalNodeDriver {
  const driver = new LocalNodeDriver(new PathSandbox(dataDir));
  drivers.push(driver);
  return driver;
}

function commandFor(args: string[] = []): string {
  return [`"${process.execPath}" "${fixture}"`, ...args].join(' ');
}

afterEach(async () => {
  for (const driver of drivers.splice(0)) {
    for (const instanceId of ['i1', 'i2']) {
      await driver.killProcessTree(instanceId).catch(() => undefined);
    }
  }
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('LocalNodeDriver', () => {
  it('spawns, streams output, verifies the pid and stops gracefully', async () => {
    const root = await makeRoot();
    const driver = makeDriver(root);
    const output: string[] = [];
    const exits: number[] = [];
    driver.on('output', (event: { text: string }) => output.push(event.text));
    driver.on('exit', (event: { code: number | null }) => exits.push(event.code ?? -1));

    const snapshot = await driver.startProcess({
      instanceId: 'i1',
      rootPath: root,
      startCommand: commandFor([`--root "${root}"`]),
      logEncoding: 'utf-8',
    });
    expect(snapshot.pid).toBeGreaterThan(0);
    expect(driver.getProcessSnapshot('i1')?.pid).toBe(snapshot.pid);

    await waitFor(() => output.some((line) => line.includes('Done (')));
    expect(await driver.verifyPid(snapshot.pid, root)).toBe(true);

    await driver.writeStdin('i1', 'say hello');
    await waitFor(() => output.some((line) => line.includes('received say hello')));

    expect(await driver.stopProcess('i1', 10)).toEqual({ forced: false });
    await waitFor(() => exits.length === 1);
    expect(driver.getProcessSnapshot('i1')).toBeNull();
  }, 30000);

  it('decodes GBK console output when configured', async () => {
    const root = await makeRoot();
    const driver = makeDriver(root);
    const output: string[] = [];
    driver.on('output', (event: { text: string }) => output.push(event.text));

    await driver.startProcess({
      instanceId: 'i1',
      rootPath: root,
      startCommand: commandFor([`--root "${root}"`, '--gbk']),
      logEncoding: 'gbk',
    });
    await waitFor(() => output.some((line) => line.includes('中文日志测试')));
    await driver.stopProcess('i1', 10);
  }, 30000);

  it('force-kills a process that ignores the stop command', async () => {
    const root = await makeRoot();
    const driver = makeDriver(root);
    const exits: string[] = [];
    driver.on('exit', (event: { instanceId: string }) => exits.push(event.instanceId));

    await driver.startProcess({
      instanceId: 'i1',
      rootPath: root,
      startCommand: commandFor([`--root "${root}"`, '--ignore-stop', '--exit-after=30000']),
      logEncoding: 'utf-8',
    });
    const result = await driver.stopProcess('i1', 1);
    expect(result.forced).toBe(true);
    await waitFor(() => exits.includes('i1'));
    expect(driver.getProcessSnapshot('i1')).toBeNull();
  }, 30000);

  it('lists and reads sandboxed files and rejects traversal, symlinks and binaries', async () => {
    const root = await makeRoot();
    const outside = await makeRoot('mcpanel-outside-');
    const driver = makeDriver(root);
    await fs.mkdir(path.join(root, 'config'));
    await fs.mkdir(path.join(root, '.mcpanel-tmp'));
    await fs.writeFile(path.join(root, 'config', 'a.yml'), 'ok: true\n');
    await fs.writeFile(path.join(root, 'config', 'bin.dat'), Buffer.from([0, 1, 2, 3]));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    await fs.symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');

    const entries = await driver.listFiles(root, '/');
    expect(entries.map((entry) => entry.name)).toEqual(['config', 'link']);
    expect(entries.find((entry) => entry.name === 'link')?.symlink).toBe(true);

    expect(await driver.readText(root, 'config/a.yml')).toMatchObject({ content: 'ok: true\n' });
    await expect(driver.readText(root, 'config/bin.dat')).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });
    await expect(driver.readText(root, 'link/secret.txt')).rejects.toMatchObject({ code: 'SYMLINK_NOT_ALLOWED' });
    await expect(driver.readText(root, '../outside.txt')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_ROOT' });
  }, 30000);
});
