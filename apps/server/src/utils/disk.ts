import fs from 'node:fs/promises';
import path from 'node:path';
import si from 'systeminformation';

export interface DiskUsage {
  free: number;
  total: number;
}

export async function diskUsage(target: string): Promise<DiskUsage> {
  try {
    const stat = await fs.statfs(target);
    return { free: stat.bavail * stat.bsize, total: stat.blocks * stat.bsize };
  } catch {
    try {
      const resolved = path.resolve(target).toLowerCase();
      const filesystems = await si.fsSize();
      const match = filesystems.find((entry) => resolved.startsWith(path.resolve(entry.mount).toLowerCase()));
      const selected = match ?? filesystems[0];
      return selected ? { free: selected.available, total: selected.size } : { free: 0, total: 0 };
    } catch {
      return { free: 0, total: 0 };
    }
  }
}
