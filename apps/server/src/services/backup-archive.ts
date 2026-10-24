import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import type { BackupManifest } from '@mcpanel/shared';
import { DEFAULT_EXCLUDES } from './backup-sources';

export interface ArchiveOptions {
  root: string;
  sources: string[];
  destination: string;
  manifest: BackupManifest;
  onProgress?: (fraction: number) => void;
}

function excluded(rel: string): boolean {
  return rel
    .split('/')
    .some((segment) => (DEFAULT_EXCLUDES as readonly string[]).includes(segment));
}

async function collectFiles(
  root: string,
  rel: string,
  files: string[],
  directories: string[],
): Promise<void> {
  const absolute = path.join(root, ...rel.split('/'));
  const stat = await fs.lstat(absolute).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    const entries = await fs.readdir(absolute).catch(() => [] as string[]);
    if (entries.length === 0) directories.push(rel);
    for (const entry of entries) {
      const childRel = `${rel}/${entry}`;
      if (excluded(childRel)) continue;
      await collectFiles(root, childRel, files, directories);
    }
    return;
  }
  if (stat.isFile()) files.push(rel);
}

export async function writeBackupArchive(options: ArchiveOptions): Promise<number> {
  const files: string[] = [];
  const directories: string[] = [];
  for (const source of options.sources) {
    if (excluded(source)) continue;
    await collectFiles(options.root, source, files, directories);
  }

  await fs.mkdir(path.dirname(options.destination), { recursive: true });
  const output = createWriteStream(options.destination);
  const archive = new ZipArchive({ zlib: { level: 6 } });

  const done = new Promise<number>((resolve, reject) => {
    output.on('close', () => resolve(archive.pointer()));
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reject(error);
    });
    archive.on('progress', (data) => {
      const total = data.entries.total || files.length;
      options.onProgress?.(total > 0 ? Math.min(1, data.entries.processed / total) : 0);
    });
  });

  archive.pipe(output);
  archive.append(`${JSON.stringify(options.manifest, null, 2)}\n`, { name: 'manifest.json' });
  // Empty directories need an explicit entry, otherwise a restore cannot recreate them.
  for (const rel of directories) {
    archive.append(Buffer.alloc(0), { name: `${rel}/` });
  }
  for (const rel of files) {
    archive.file(path.join(options.root, ...rel.split('/')), { name: rel });
  }
  await archive.finalize();
  const bytes = await done;
  options.onProgress?.(1);
  return bytes;
}
