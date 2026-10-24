import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { stamp } from '../utils/stamp';

export interface PanelBackupServiceDeps {
  sqlite: Database.Database;
  dataDir: string;
}

export interface PanelSnapshot {
  path: string;
  filename: string;
  sizeBytes: number;
}

export class PanelBackupService {
  constructor(private readonly deps: PanelBackupServiceDeps) {}

  async createSnapshot(): Promise<PanelSnapshot> {
    const dir = path.join(this.deps.dataDir, 'tmp');
    await fs.mkdir(dir, { recursive: true });
    const base = `panel-${stamp(new Date())}`;
    let filename = `${base}.db`;
    let target = path.join(dir, filename);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const exists = await fs
        .access(target)
        .then(() => true)
        .catch(() => false);
      if (!exists) break;
      filename = `${base}-${randomBytes(2).toString('hex')}.db`;
      target = path.join(dir, filename);
    }
    try {
      await this.deps.sqlite.backup(target);
    } catch (error) {
      await fs.rm(target, { force: true }).catch(() => undefined);
      throw error;
    }
    const stat = await fs.stat(target);
    return { path: target, filename, sizeBytes: stat.size };
  }
}
