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

export async function importPanelData(source: string, target: string): Promise<void> {
  if (!isPanelDataDir(source)) throw new Error('所选目录不是面板 data 目录（缺少 panel.db）');
  if (fs.existsSync(path.join(target, 'panel.db'))) throw new Error('目标目录已有面板数据');
  await fsp.mkdir(path.dirname(target), { recursive: true });
  // The desktop shell creates data/logs before import, so the target may already exist; merge into it without
  // overwriting files that are already there (panel.db presence was checked above).
  await fsp.cp(source, target, { recursive: true, force: false, errorOnExist: false, dereference: true });
}
