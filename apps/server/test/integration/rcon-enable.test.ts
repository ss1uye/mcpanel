import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PathSandbox } from '../../src/nodes/path-sandbox';
import { InstanceService } from '../../src/services/instance-service';
import { RconConfigService, generateRconPassword } from '../../src/services/rcon-config-service';
import { RconService } from '../../src/services/rcon-service';
import { insertInstanceRow } from '../helpers/factory';
import { createTestDb, type TestDb } from '../helpers/db';

let ctx: TestDb | undefined;
const roots: string[] = [];

async function prepare(otherPort?: number) {
  ctx = createTestDb();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-rcon-enable-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'server.properties'), 'motd=hi\nserver-port=25565\n');
  const instance = insertInstanceRow(ctx.db, { rootPath: root });
  if (otherPort !== undefined) {
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-rcon-other-'));
    roots.push(otherRoot);
    await fs.writeFile(path.join(otherRoot, 'server.properties'), `enable-rcon=true\nrcon.port=${otherPort}\n`);
    insertInstanceRow(ctx.db, { rootPath: otherRoot });
  }
  const sandbox = new PathSandbox(ctx.dir);
  const service = new RconConfigService(sandbox, new InstanceService(ctx.db, ctx.dir), new RconService());
  return { service, instance, root };
}

afterEach(async () => {
  ctx?.close();
  ctx = undefined;
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('RconConfigService', () => {
  it('generates 16-character alphanumeric passwords without ambiguous characters', () => {
    const password = generateRconPassword();
    expect(password).toHaveLength(16);
    expect(password).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(password).not.toMatch(/[0O1lI]/);
  });

  it('enables RCON and keeps every other line intact', async () => {
    const { service, instance, root } = await prepare();
    const result = await service.enable(instance);
    expect(result.port).toBe(25575);
    expect(result.password).toMatch(/^[A-Za-z0-9]{16}$/);

    const raw = await fs.readFile(path.join(root, 'server.properties'), 'utf8');
    expect(raw).toContain('motd=hi\n');
    expect(raw).toContain('enable-rcon=true\n');
    expect(raw).toContain(`rcon.password=${result.password}\n`);
    expect(raw).toContain('rcon.port=25575\n');
  });

  it('skips ports already used by another managed instance', async () => {
    const { service, instance } = await prepare(25575);
    const result = await service.enable(instance);
    expect(result.port).toBe(25576);
  });

  it('fails with PORT_IN_USE when every candidate is taken', async () => {
    ctx = createTestDb();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-rcon-full-'));
    roots.push(root);
    await fs.writeFile(path.join(root, 'server.properties'), 'motd=hi\n');
    const instance = insertInstanceRow(ctx.db, { rootPath: root });
    for (let port = 25575; port <= 25584; port += 1) {
      const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-rcon-taken-'));
      roots.push(otherRoot);
      await fs.writeFile(path.join(otherRoot, 'server.properties'), `enable-rcon=true\nrcon.port=${port}\n`);
      insertInstanceRow(ctx.db, { rootPath: otherRoot });
    }
    const service = new RconConfigService(
      new PathSandbox(ctx.dir),
      new InstanceService(ctx.db, ctx.dir),
      new RconService(),
    );
    await expect(service.enable(instance)).rejects.toMatchObject({ code: 'PORT_IN_USE' });
  });
});
