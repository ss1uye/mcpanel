import fs from 'node:fs/promises';
import type { InstanceRow } from '../db/schema';
import { AppError } from '../utils/errors';
import type { RconService } from './rcon-service';

const POLL_INTERVAL_MS = 400;
const SAVED_PATTERN = /Saved the game|Saved the world/i;

export interface FreezeDeps {
  rcon: RconService;
  instance: InstanceRow;
  logFile: string;
  waitTimeoutMs?: number;
}

async function fileSize(file: string): Promise<number | null> {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return null;
  }
}

async function waitForSavedLine(logFile: string, offset: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const size = await fileSize(logFile);
    if (size === null || size <= offset) continue;
    const handle = await fs.open(logFile, 'r');
    try {
      const length = size - offset;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      if (SAVED_PATTERN.test(buffer.toString('utf8'))) return;
    } finally {
      await handle.close();
    }
  }
  throw new AppError('BACKUP_REQUIRES_STOP_OR_RCON', '等待存档写入超时，已中止备份');
}

/**
 * Runs `task` with saving disabled, after a flushed save has been confirmed in the log.
 * `save-on` is always attempted, even when packing throws.
 */
export async function withFrozenServer<T>(deps: FreezeDeps, task: () => Promise<T>): Promise<T> {
  const timeoutMs = deps.waitTimeoutMs ?? 60_000;
  const offset = await fileSize(deps.logFile);
  if (offset === null) {
    throw new AppError('BACKUP_REQUIRES_STOP_OR_RCON', '找不到 logs/latest.log，无法确认存档已写入磁盘');
  }
  await deps.rcon.send(deps.instance, 'save-off');
  try {
    await deps.rcon.send(deps.instance, 'save-all flush');
    await waitForSavedLine(deps.logFile, offset, timeoutMs);
    return await task();
  } finally {
    await deps.rcon.send(deps.instance, 'save-on').catch(() => undefined);
  }
}
