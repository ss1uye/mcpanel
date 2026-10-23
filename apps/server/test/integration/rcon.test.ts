import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { RconService } from '../../src/services/rcon-service';
import { createTestDb, type TestDb } from '../helpers/db';
import { insertInstanceRow } from '../helpers/factory';
import { startFakeRcon } from '../fixtures/fake-rcon.mjs';

const contexts: TestDb[] = [];
const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

async function setup({
  password = 'secret',
  enabled = true,
  rconHost = null,
  respond = true,
}: { password?: string; enabled?: boolean; rconHost?: string | null; respond?: boolean } = {}) {
  const ctx = createTestDb();
  contexts.push(ctx);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-rcon-'));
  dirs.push(root);

  let port = 25599;
  if (respond) {
    const fake = await startFakeRcon({ password });
    port = fake.port;
    closers.push(fake.close);
  }

  const lines = [`enable-rcon=${enabled}`, `rcon.port=${port}`, `rcon.password=${password}`, 'server-ip=0.0.0.0'];
  await fs.writeFile(path.join(root, 'server.properties'), `${lines.join('\n')}\n`);

  const instance = insertInstanceRow(ctx.db, { name: `rcon-${randomUUID()}`, rootPath: root, rconHost });
  return { service: new RconService(), instance, root, port };
}

afterEach(async () => {
  for (const closer of closers.splice(0)) await closer();
  for (const ctx of contexts.splice(0)) ctx.close();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('RconService', () => {
  it('connects, runs a command and caches the connected status', async () => {
    const { service, instance } = await setup();
    const probe = await service.test(instance);
    expect(probe).toEqual({ status: 'connected', error: null });
    expect(await service.send(instance, 'list')).toContain('players online');
    expect(service.getCachedStatus(instance.id)).toBe('connected');
    service.closeAll();
  });

  it('derives the host from server-ip unless rconHost overrides it', async () => {
    const { service, instance } = await setup({ rconHost: '127.0.0.1' });
    expect(await service.resolveTarget(instance)).toMatchObject({ kind: 'ok', target: { host: '127.0.0.1' } });
    const derived = await setup();
    expect(await derived.service.resolveTarget(derived.instance)).toMatchObject({
      kind: 'ok',
      target: { host: '127.0.0.1' },
    });
  });

  it('reports disabled and missing_password without connecting', async () => {
    const disabled = await setup({ enabled: false });
    expect(await disabled.service.test(disabled.instance)).toMatchObject({ status: 'disabled' });
    expect(disabled.service.getCachedStatus(disabled.instance.id)).toBe('disabled');

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-rcon-'));
    dirs.push(root);
    await fs.writeFile(path.join(root, 'server.properties'), 'enable-rcon=true\nrcon.port=25575\nrcon.password=\n');
    const ctx = createTestDb();
    contexts.push(ctx);
    const instance = insertInstanceRow(ctx.db, { name: 'empty-password', rootPath: root });
    const service = new RconService();
    expect(await service.test(instance)).toMatchObject({ status: 'auth_failed' });
  });

  it('reports auth_failed for a wrong password and never leaks it', async () => {
    const { service, instance, root, port } = await setup({ password: 'right-password' });
    await fs.writeFile(
      path.join(root, 'server.properties'),
      `enable-rcon=true\nrcon.port=${port}\nrcon.password=wrong-password\n`,
    );
    const probe = await service.test(instance);
    expect(probe.status).toBe('auth_failed');
    expect(JSON.stringify(probe)).not.toContain('wrong-password');
  });

  it('reports unreachable when nothing is listening', async () => {
    const { service, instance } = await setup({ respond: false });
    const probe = await service.test(instance);
    expect(probe.status).toBe('unreachable');
    expect(service.getCachedStatus(instance.id)).toBe('unreachable');
  });

  it('statusFor() never claims a failed connection for an RCON-disabled server', async () => {
    const disabled = await setup({ enabled: false });
    expect(await disabled.service.statusFor(disabled.instance)).toBe('disabled');

    const enabled = await setup({ respond: false });
    expect(await enabled.service.statusFor(enabled.instance)).toBe('unreachable');

    const connected = await setup();
    await connected.service.test(connected.instance);
    expect(await connected.service.statusFor(connected.instance)).toBe('connected');
  });

  it('throws RCON_UNAVAILABLE when sending to a dead server', async () => {
    const { service, instance } = await setup({ respond: false });
    await expect(service.send(instance, 'list')).rejects.toMatchObject({ code: 'RCON_UNAVAILABLE' });
  });

  it('invalidate() drops the cached connection and status', async () => {
    const { service, instance } = await setup();
    await service.test(instance);
    expect(service.getCachedStatus(instance.id)).toBe('connected');
    service.invalidate(instance.id);
    expect(service.getCachedStatus(instance.id)).toBe('unreachable');
    service.closeAll();
  });
});
