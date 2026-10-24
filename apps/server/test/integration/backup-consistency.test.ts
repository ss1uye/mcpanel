import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withFrozenServer } from '../../src/services/backup-consistency';
import { RconService } from '../../src/services/rcon-service';
import { createTestDb, type TestDb } from '../helpers/db';
import { insertInstanceRow } from '../helpers/factory';
import { startFakeRcon } from '../fixtures/fake-rcon.mjs';

let ctx: TestDb | undefined;
let dir: string;
const closers: Array<() => Promise<void>> = [];

async function setup(delayMs = 0, withLog = true) {
  ctx = createTestDb();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpanel-freeze-'));
  const logFile = path.join(dir, 'latest.log');
  if (withLog) await fs.writeFile(logFile, '[Server thread/INFO]: old line\n');
  const password = 'secret';
  const fake = await startFakeRcon({ password, logFile, saveAllDelayMs: delayMs });
  closers.push(fake.close);
  const instance = insertInstanceRow(ctx.db, { name: `freeze-${Date.now()}`, rootPath: dir, rconHost: '127.0.0.1' });
  await fs.writeFile(
    path.join(dir, 'server.properties'),
    `enable-rcon=true\nrcon.port=${fake.port}\nrcon.password=${password}\n`,
  );
  const rcon = new RconService();
  await rcon.test(instance);
  return { instance, rcon, logFile };
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  ctx?.close();
  ctx = undefined;
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe('withFrozenServer', () => {
  it('freezes saves, waits for the flush log line and then runs the task', async () => {
    const { instance, rcon, logFile } = await setup(10);
    const result = await withFrozenServer({ rcon, instance, logFile, waitTimeoutMs: 5_000 }, async () => {
      expect(await fs.readFile(logFile, 'utf8')).toContain('Saved the game');
      return 'packed';
    });
    expect(result).toBe('packed');
  });

  it('aborts when the log never confirms the flush', async () => {
    const { instance, rcon, logFile } = await setup(10, false);
    await expect(
      withFrozenServer({ rcon, instance, logFile, waitTimeoutMs: 200 }, async () => 'never'),
    ).rejects.toMatchObject({ code: 'BACKUP_REQUIRES_STOP_OR_RCON' });
  });
});
