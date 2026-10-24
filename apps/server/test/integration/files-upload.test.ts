import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
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

function makeZip(files: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(text, 'utf8');
    const data = deflateRawSync(raw);
    const crc = crc32(raw) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralSize = central.reduce((total, chunk) => total + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

async function makeApp(maxUploadMb = 1) {
  ctx = createTestDb();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-upload-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'mods'));
  await fs.writeFile(path.join(root, 'mods', 'old.jar'), 'jar');
  await fs.writeFile(path.join(root, 'ops.json'), '[]');

  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: ctx.dir, MAX_UPLOAD_MB: String(maxUploadMb) });
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
    headers: { origin: TEST_ORIGIN, cookie: jar.header(), 'x-csrf-token': json<{ token: string }>(csrf).token },
  };
}

async function upload(
  app: Awaited<ReturnType<typeof makeApp>>['app'],
  instanceId: string,
  headers: { cookie: string; 'x-csrf-token': string },
  targetPath: string,
  filename: string,
  content: Buffer,
) {
  const boundary = '----mcpanel-test-boundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n${targetPath}\r\n`),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: 'POST',
    url: `/api/instances/${instanceId}/files/upload`,
    headers: {
      origin: TEST_ORIGIN,
      cookie: headers.cookie,
      'x-csrf-token': headers['x-csrf-token'],
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: body,
  });
}

afterEach(async () => {
  ctx?.close();
  ctx = undefined;
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('file upload, unzip and mods', () => {
  it('streams an upload into the requested directory', async () => {
    const { app, root, instanceId, headers } = await makeApp();
    const res = await upload(app, instanceId, headers, '/mods', 'new.jar', Buffer.from('jar-bytes'));
    expect(res.statusCode).toBe(201);
    expect(await fs.readFile(path.join(root, 'mods', 'new.jar'), 'utf8')).toBe('jar-bytes');
  });

  it('rejects an upload larger than MAX_UPLOAD_MB', async () => {
    const { app, root, instanceId, headers } = await makeApp(1);
    const res = await upload(app, instanceId, headers, '/mods', 'big.jar', Buffer.alloc(2 * 1024 * 1024, 1));
    expect(res.statusCode).toBe(413);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('FILE_TOO_LARGE');
    await expect(fs.stat(path.join(root, 'mods', 'big.jar'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('toggles jar and jar.disabled only inside mods/', async () => {
    const { app, root, instanceId, headers } = await makeApp();
    const disable = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/files/mods/toggle`,
      headers,
      payload: { path: '/mods/old.jar' },
    });
    expect(disable.statusCode).toBe(200);
    expect((await fs.stat(path.join(root, 'mods', 'old.jar.disabled'))).isFile()).toBe(true);

    const enable = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/files/mods/toggle`,
      headers,
      payload: { path: '/mods/old.jar.disabled' },
    });
    expect(enable.statusCode).toBe(200);
    expect((await fs.stat(path.join(root, 'mods', 'old.jar'))).isFile()).toBe(true);

    const outside = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/files/mods/toggle`,
      headers,
      payload: { path: '/ops.json' },
    });
    expect(outside.statusCode).toBe(400);
  });

  it('extracts a zip and rejects zip-slip entries', async () => {
    const { app, root, instanceId, headers } = await makeApp();
    await fs.writeFile(path.join(root, 'pack.zip'), makeZip({ 'config/a.txt': 'hello' }));

    const ok = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/files/unzip`,
      headers,
      payload: { path: '/pack.zip', targetDir: '/unpacked' },
    });
    expect(ok.statusCode).toBe(200);
    expect(await fs.readFile(path.join(root, 'unpacked', 'config', 'a.txt'), 'utf8')).toBe('hello');

    await fs.writeFile(path.join(root, 'evil.zip'), makeZip({ '../escape.txt': 'x' }));
    const evil = await app.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/files/unzip`,
      headers,
      payload: { path: '/evil.zip', targetDir: '/unpacked' },
    });
    expect(evil.statusCode).toBe(400);
    expect(json<{ error: { code: string } }>(evil).error.code).toBe('ZIP_INVALID');
    await expect(fs.stat(path.join(root, '..', 'escape.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
