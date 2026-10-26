import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export function isPanelDataDir(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'panel.db')).isFile();
  } catch {
    return false;
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(dir);
    if (!stat.isDirectory()) throw new Error('目标目录已有数据（目标路径已存在且不是目录）');
    const entries = await fsp.readdir(dir);
    if (entries.length > 0) throw new Error('目标目录已有数据，请选择空目录或不存在的位置');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function importPanelData(source: string, target: string): Promise<void> {
  const sourceDir = path.resolve(source);
  const targetDir = path.resolve(target);
  if (sourceDir === targetDir) throw new Error('目标目录不能与源目录相同');
  if (isInside(sourceDir, targetDir)) throw new Error('目标目录不能位于源目录内');
  if (isInside(targetDir, sourceDir)) throw new Error('源目录不能位于目标目录内');
  if (!isPanelDataDir(sourceDir)) throw new Error('所选目录不是面板 data 目录（缺少 panel.db）');
  if (fs.existsSync(path.join(targetDir, 'panel.db'))) throw new Error('目标目录已有面板数据');

  // The target may be absent or an empty directory (Task 5 creates data/logs only after a successful import).
  const emptyTarget = await isEmptyDir(targetDir);
  await fsp.mkdir(path.dirname(targetDir), { recursive: true });

  // Copy into a sibling staging directory first so a mid-copy failure never leaves a partial target behind.
  const staging = `${targetDir}.import-${randomUUID()}`;
  let removedEmptyTarget = false;
  try {
    await fsp.cp(sourceDir, staging, { recursive: true, force: false, errorOnExist: true, dereference: true });
    if (emptyTarget) {
      await fsp.rmdir(targetDir);
      removedEmptyTarget = true;
    }
    await fsp.rename(staging, targetDir);
  } catch (error) {
    if (removedEmptyTarget) await fsp.mkdir(targetDir, { recursive: true }).catch(() => undefined);
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
