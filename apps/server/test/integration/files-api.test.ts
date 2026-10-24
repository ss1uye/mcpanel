import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { LoginThrottle } from '../../src/auth/guard';
import { SessionService } from '../../src/auth/session';
import { loadConfig } from '../../src/config';
import { silentLogger } from '../../src/logger';
import { LocalNodeDriver } from '../../src/nodes/local-driver';
import { PathSandbox } from '../../src/nodes/path-sandbox';
import { AuditService } from '../../src/services/audit-service';
import { FileService } from '../../src/services/file-service';
import { InstanceService } from '../../src/services/instance-service';
import { ProbeService } from '../../src/services/probe-service';
import { RconService } from '../../src/services/rcon-service';
import type { InstanceSupervisor } from '../../src/services/instance-supervisor';
import { insertInstance, insertUser } from '../helpers/factory';
import { createTestDb, type TestDb } from '../helpers/db';
import { CookieJar, TEST_ORIGIN, json } from '../helpers/http';

let ctx: TestDb | undefined;
const roots: string[] = [];

async function makeApp() {
  ctx = createTestDb();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-files-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'server.properties'), 'motd=hi\nserver-port=25565\n');
  await fs.mkdir(path.join(root, 'mods'));
  await fs.writeFile(path.join(root, 'mods', 'a.jar'), 'jar');

  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: ctx.dir });
  const sessions = new SessionService(ctx.db);
  const { token } = sessions.create(insertUser(ctx.db), null, null);
  const instanceId = insertInstance(ctx.db, { rootPath: root });
  const sandbox = new PathSandbox(ctx.dir);
  const supervisor = {
    getStatus: () => ({
      instanceId,
      state: 'stopped',
      pid: null,
      startedAt: null,
      exitCode: null,
      error: null,
    }),
  } as unknown as InstanceSupervisor;
  const app = await buildApp(
    config,
    ctx.db,
    {
      sessions,
      audit: new AuditService(ctx.db),
      loginThrottle: new LoginThrottle(),
      instances: new InstanceService(ctx.db, ctx.dir),
      supervisor,
      rcon: new RconService(),
      driver: new LocalNodeDriver(sandbox),
      probe: new ProbeService(sandbox, async () => null),
      files: new FileService(sandbox),
    },
    { logger: silentLogger() },
  );

  const jar = new CookieJar();
  const csrf = await app.inject({ method: 'GET', url: '/api/auth/csrf', headers: { cookie: `mcpanel_session=${token}` } });
  jar.absorb(csrf);
  jar.set('mcpanel_session', token);
  return {
    app,
    root,
    instanceId,
    readHeaders: { cookie: jar.header() },
    headers: { origin: TEST_ORIGIN, cookie: jar.header(), 'x-csrf-token': json<{ token: string }>(csrf).token },
  };
}

afterEach(async () => {
  ctx?.close();
  ctx = undefined;
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('files API', () => {
  it('lists directories, reads text and hides the panel temp directory', async () => {
    const { app, instanceId, readHeaders } = await makeApp();
    const list = await app.inject({
      method: 'GET',
      url: `/api/instances/${instanceId}/files?path=/mods`,
      headers: readHeaders,
    });
    expect(list.statusCode).toBe(200);
    const body = json<{ path: string; entries: Array<{ name: string; type: string; editable: boolean }> }>(list);
    expect(body.path).toBe('/mods');
    expect(body.entries).toEqual([expect.objectContaining({ name: 'a.jar', type: 'file', editable: false })]);

    const content = await app.inject({
      method: 'GET',
      url: `/api/instances/${instanceId}/files/content?path=/server.properties`,
      headers: readHeaders,
    });
    expect(content.statusCode).toBe(200);
    expect(json<{ content: string; eol: string }>(content)).toMatchObject({
      content: 'motd=hi\nserver-port=25565\n',
      eol: '\n',
    });
  });

  it('saves with an mtime guard and rejects traversal outside the instance root', async () => {
    const { app, root, instanceId, headers, readHeaders } = await makeApp();
    const before = json<{ mtime: number }>(
      await app.inject({
        method: 'GET',
        url: `/api/instances/${instanceId}/files/content?path=/server.properties`,
        headers: readHeaders,
      }),
    );

    const saved = await app.inject({
      method: 'PUT',
      url: `/api/instances/${instanceId}/files/content`,
      headers,
      payload: { path: '/server.properties', content: 'motd=new\n', expectedMtime: before.mtime },
    });
    expect(saved.statusCode).toBe(200);
    expect(await fs.readFile(path.join(root, 'server.properties'), 'utf8')).toBe('motd=new\n');

    const conflict = await app.inject({
      method: 'PUT',
      url: `/api/instances/${instanceId}/files/content`,
      headers,
      payload: { path: '/server.properties', content: 'x', expectedMtime: before.mtime },
    });
    expect(conflict.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(conflict).error.code).toBe('MTIME_CONFLICT');

    const escape = await app.inject({
      method: 'GET',
      url: `/api/instances/${instanceId}/files?path=../../`,
      headers: readHeaders,
    });
    // The request schema rejects obvious traversal first; PathSandbox is the second line of defense.
    expect(escape.statusCode).toBe(400);
    expect(json<{ error: { code: string } }>(escape).error.code).toBe('VALIDATION_ERROR');
  });

  it('creates, renames and deletes entries with a recursive guard', async () => {
    const { app, root, instanceId, headers } = await makeApp();
    const mkdir = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/files/mkdir`,
      headers,
      payload: { path: '/config' },
    });
    expect(mkdir.statusCode).toBe(201);
    expect((await fs.stat(path.join(root, 'config'))).isDirectory()).toBe(true);

    const mkdirAgain = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/files/mkdir`,
      headers,
      payload: { path: '/config' },
    });
    expect(mkdirAgain.statusCode).toBe(400);

    const rename = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/files/rename`,
      headers,
      payload: { path: '/config', newName: 'config2' },
    });
    expect(rename.statusCode).toBe(200);
    expect((await fs.stat(path.join(root, 'config2'))).isDirectory()).toBe(true);

    await fs.writeFile(path.join(root, 'config2', 'x.txt'), 'x');
    const refuse = await app.inject({
      method: 'DELETE',
      url: `/api/instances/${instanceId}/files`,
      headers,
      payload: { path: '/config2' },
    });
    expect(refuse.statusCode).toBe(400);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/instances/${instanceId}/files`,
      headers,
      payload: { path: '/config2', recursive: true },
    });
    expect(remove.statusCode).toBe(204);
    await expect(fs.stat(path.join(root, 'config2'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects deleting the instance root and symbol links', async () => {
    const { app, root, instanceId, headers } = await makeApp();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-outside-'));
    roots.push(outside);
    await fs.symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');

    const rootDelete = await app.inject({
      method: 'DELETE',
      url: `/api/instances/${instanceId}/files`,
      headers,
      payload: { path: '/', recursive: true },
    });
    expect(rootDelete.statusCode).toBe(400);

    const linkedDelete = await app.inject({
      method: 'DELETE',
      url: `/api/instances/${instanceId}/files`,
      headers,
      payload: { path: '/link', recursive: true },
    });
    expect(linkedDelete.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(linkedDelete).error.code).toBe('SYMLINK_NOT_ALLOWED');
  });
});
