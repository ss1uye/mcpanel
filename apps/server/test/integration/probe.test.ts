import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PathSandbox } from '../../src/nodes/path-sandbox';
import { ProbeService } from '../../src/services/probe-service';

const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-probe-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('ProbeService', () => {
  it('detects scripts, jars, properties and warnings', async () => {
    const dataDir = await temp();
    const root = await temp();
    await fs.writeFile(path.join(root, 'run.bat'), '@echo off');
    await fs.writeFile(path.join(root, 'fabric-server-launch.jar'), '');
    await fs.writeFile(
      path.join(root, 'server.properties'),
      'level-name=survival\nserver-port=25570\nenable-rcon=true\nrcon.port=25580\nrcon.password=\nonline-mode=false\n',
    );
    await fs.writeFile(path.join(root, 'eula.txt'), 'eula=false\n');
    await fs.mkdir(path.join(root, 'mods'));
    await fs.mkdir(path.join(root, 'config'));

    const service = new ProbeService(new PathSandbox(dataDir), async () => ({ path: '/java', major: 21 }));
    const result = await service.probe(root, []);
    expect(result.detected).toMatchObject({
      startScripts: ['run.bat'],
      serverJars: ['fabric-server-launch.jar'],
      levelName: 'survival',
      serverPort: 25570,
      enableRcon: true,
      rconPort: 25580,
      onlineMode: false,
      eula: false,
      hasMods: true,
      hasConfig: true,
    });
    expect(result.suggestedStartCommand).toBe('run.bat');
    expect(result.java).toEqual({ path: '/java', major: 21 });
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(['EULA_NOT_ACCEPTED', 'RCON_PASSWORD_EMPTY']),
    );
  });

  it('falls back on invalid ports and compares boolean values case-insensitively', async () => {
    const dataDir = await temp();
    const root = await temp();
    await fs.writeFile(
      path.join(root, 'server.properties'),
      'server-port=0x10\nrcon.port=70000\nenable-rcon=TRUE\nonline-mode=FALSE\n',
    );
    const service = new ProbeService(new PathSandbox(dataDir), async () => null);
    const result = await service.probe(root, []);
    expect(result.detected.serverPort).toBe(25565);
    expect(result.detected.rconPort).toBe(25575);
    expect(result.detected.enableRcon).toBe(true);
    expect(result.detected.onlineMode).toBe(false);
  });

  it('warns instead of failing when server.properties is a directory', async () => {
    const dataDir = await temp();
    const root = await temp();
    await fs.mkdir(path.join(root, 'server.properties'));
    const service = new ProbeService(new PathSandbox(dataDir), async () => null);
    const result = await service.probe(root, []);
    expect(result.valid).toBe(true);
    expect(result.detected.levelName).toBe('world');
    expect(result.detected.serverPort).toBe(25565);
    expect(result.warnings.map((warning) => warning.code)).toContain('PROPERTIES_UNREADABLE');
  });

  it('warns and falls back to defaults when server.properties is missing', async () => {
    const dataDir = await temp();
    const root = await temp();
    const service = new ProbeService(new PathSandbox(dataDir), async () => null);
    const result = await service.probe(root, []);
    expect(result.detected.levelName).toBe('world');
    expect(result.detected.serverPort).toBe(25565);
    expect(result.detected.rconPort).toBe(25575);
    expect(result.warnings.map((warning) => warning.code)).toContain('PROPERTIES_UNREADABLE');
  });

  it.runIf(process.platform === 'win32')('warns instead of failing when server.properties is a junction', async () => {
    const dataDir = await temp();
    const root = await temp();
    const outside = await temp();
    await fs.symlink(outside, path.join(root, 'server.properties'), 'junction');
    const service = new ProbeService(new PathSandbox(dataDir), async () => null);
    const result = await service.probe(root, []);
    expect(result.valid).toBe(true);
    expect(result.detected.levelName).toBe('world');
    expect(result.warnings.map((warning) => warning.code)).toContain('PROPERTIES_UNREADABLE');
  });

  it('does not leak an outside properties file through a file symlink', async (context) => {
    const dataDir = await temp();
    const root = await temp();
    const outside = await temp();
    const secret = path.join(outside, 'server.properties');
    await fs.writeFile(secret, 'level-name=leaked\nserver-port=12345\n');
    try {
      await fs.symlink(secret, path.join(root, 'server.properties'), 'file');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') context.skip(`file symlinks unavailable: ${code}`);
      throw error;
    }
    const service = new ProbeService(new PathSandbox(dataDir), async () => null);
    const result = await service.probe(root, []);
    expect(result.detected.levelName).toBe('world');
    expect(result.detected.serverPort).toBe(25565);
    expect(result.warnings.map((warning) => warning.code)).toContain('PROPERTIES_UNREADABLE');
    expect(JSON.stringify(result)).not.toContain('leaked');
  });

  it('does not accept eula=true through a symlinked eula.txt', async (context) => {
    const dataDir = await temp();
    const root = await temp();
    const outside = await temp();
    const secret = path.join(outside, 'eula.txt');
    await fs.writeFile(secret, 'eula=true\n');
    try {
      await fs.symlink(secret, path.join(root, 'eula.txt'), 'file');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') context.skip(`file symlinks unavailable: ${code}`);
      throw error;
    }
    const service = new ProbeService(new PathSandbox(dataDir), async () => null);
    const result = await service.probe(root, []);
    expect(result.detected.eula).toBe(false);
    expect(result.warnings.map((warning) => warning.code)).toContain('EULA_NOT_ACCEPTED');
  });

  it('accepts eula with surrounding whitespace and mixed case', async () => {
    const dataDir = await temp();
    const root = await temp();
    await fs.writeFile(path.join(root, 'eula.txt'), '  EUla = true  \n');
    const service = new ProbeService(new PathSandbox(dataDir), async () => null);
    const result = await service.probe(root, []);
    expect(result.detected.eula).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).not.toContain('EULA_NOT_ACCEPTED');
  });

  it('accepts eula with CRLF line endings', async () => {
    const dataDir = await temp();
    const root = await temp();
    await fs.writeFile(path.join(root, 'eula.txt'), '#By changing the setting below\r\neula=true\r\n');
    const service = new ProbeService(new PathSandbox(dataDir), async () => null);
    const result = await service.probe(root, []);
    expect(result.detected.eula).toBe(true);
  });

  it('does not match eula=true split across lines', async () => {
    const dataDir = await temp();
    const root = await temp();
    await fs.writeFile(path.join(root, 'eula.txt'), 'eula=\ntrue\n');
    const service = new ProbeService(new PathSandbox(dataDir), async () => null);
    const result = await service.probe(root, []);
    expect(result.detected.eula).toBe(false);
    expect(result.warnings.map((warning) => warning.code)).toContain('EULA_NOT_ACCEPTED');
  });
});
