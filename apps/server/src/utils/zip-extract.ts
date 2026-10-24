import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { AppError } from './errors';

export interface ExtractLimits {
  maxEntries?: number;
  maxBytes?: number;
  /** Lets callers re-run sandbox checks (e.g. symlinked parent directories) for every entry. */
  resolveTarget?: (entryName: string) => Promise<string>;
}

export interface ExtractResult {
  entries: number;
  bytes: number;
}

function unsafeEntry(name: string): boolean {
  const normalized = name.replaceAll('\\', '/');
  return (
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..') ||
    normalized.includes('\0')
  );
}

export async function extractZipSafe(
  archivePath: string,
  destinationDir: string,
  limits: ExtractLimits = {},
): Promise<ExtractResult> {
  const maxEntries = limits.maxEntries ?? 100_000;
  const maxBytes = limits.maxBytes ?? 10 * 1024 * 1024 * 1024;
  await fs.mkdir(destinationDir, { recursive: true });

  return new Promise<ExtractResult>((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(new AppError('ZIP_INVALID', '压缩包无法打开'));
        return;
      }
      let entries = 0;
      let bytes = 0;
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error instanceof AppError ? error : new AppError('ZIP_INVALID', '解压失败'));
      };
      zip.on('error', fail);
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ entries, bytes });
      });
      zip.on('entry', (entry: yauzl.Entry) => {
        entries += 1;
        if (entries > maxEntries) {
          fail(new AppError('ZIP_INVALID', '压缩包条目过多'));
          return;
        }
        // bytes is only counted by the Transform below: the declared
        // uncompressedSize in the central directory is untrusted, and adding it
        // here double-counts against maxBytes (entries stream through both paths).
        if (unsafeEntry(entry.fileName)) {
          fail(new AppError('ZIP_INVALID', '压缩包包含越界路径'));
          return;
        }
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (mode === 0o120000) {
          fail(new AppError('ZIP_INVALID', '压缩包包含符号链接条目'));
          return;
        }

        if (entry.fileName.endsWith('/')) {
          const dirName = entry.fileName.replace(/\/+$/, '');
          if (!dirName) {
            zip.readEntry();
            return;
          }
          const resolveDir = limits.resolveTarget ?? (async () => path.join(destinationDir, ...dirName.split('/')));
          void resolveDir(dirName)
            .then((dir) => fs.mkdir(dir, { recursive: true }))
            .then(() => zip.readEntry())
            .catch(fail);
          return;
        }
        zip.openReadStream(entry, (streamError, readStream) => {
          if (streamError || !readStream) {
            fail(streamError ?? new AppError('ZIP_INVALID', '无法读取条目'));
            return;
          }
          const fallback = path.join(destinationDir, ...entry.fileName.split('/'));
          const resolveTarget = limits.resolveTarget ?? (async () => fallback);
          void resolveTarget(entry.fileName)
            .then(async (out) => {
              await fs.mkdir(path.dirname(out), { recursive: true });
              // Count actual bytes: the declared size in the central directory is untrusted.
              let writtenEntry = 0;
              const counter = new Transform({
                transform(chunk: Buffer, _encoding, callback) {
                  writtenEntry += chunk.length;
                  bytes += chunk.length;
                  if (bytes > maxBytes) {
                    callback(new AppError('ZIP_INVALID', '解压后体积超过上限'));
                    return;
                  }
                  callback(null, chunk);
                },
              });
              await pipeline(readStream, counter, createWriteStream(out));
              void writtenEntry;
              zip.readEntry();
            })
            .catch(fail);
        });
      });
      zip.readEntry();
    });
  });
}
