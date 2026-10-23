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
});
