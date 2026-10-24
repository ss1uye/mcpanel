import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import type { FileEntryInfo, FileListResult, TextFileContent } from '@mcpanel/shared';
import type { PathSandbox } from '../nodes/path-sandbox';
import { AppError } from '../utils/errors';
import { writeFileAtomic } from '../utils/fs-atomic';

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 100_000;
const MAX_ZIP_BYTES = 10 * 1024 * 1024 * 1024;

const BINARY_EXTENSIONS = new Set([
  '.jar',
  '.zip',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ogg',
  '.wav',
  '.mp3',
  '.class',
  '.dat',
  '.mca',
  '.mcr',
  '.db',
  '.lock',
]);

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isUnsafeEntry(name: string): boolean {
  const normalized = name.replaceAll('\\', '/');
  return (
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..') ||
    normalized.includes('\0')
  );
}

export class FileService {
  constructor(private readonly sandbox: PathSandbox) {}

  async list(root: string, relPath: string): Promise<FileListResult> {
    const dir = await this.sandbox.resolve(root, relPath);
    const dirStat = await fs.lstat(dir);
    if (dirStat.isSymbolicLink()) throw new AppError('SYMLINK_NOT_ALLOWED', '不允许访问符号链接');
    if (!dirStat.isDirectory()) throw new AppError('VALIDATION_ERROR', '目标不是目录');
    const entries: FileEntryInfo[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.mcpanel-tmp') continue;
      const absolute = path.join(dir, entry.name);
      const stat = await fs.lstat(absolute);
      const ext = path.extname(entry.name).toLowerCase();
      const isFile = stat.isFile();
      entries.push({
        name: entry.name,
        type: stat.isDirectory() ? 'directory' : 'file',
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        symlink: stat.isSymbolicLink(),
        editable: isFile && stat.size <= MAX_TEXT_BYTES && !BINARY_EXTENSIONS.has(ext),
      });
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
    const normalized = this.sandbox.normalizeRelative(relPath);
    return { path: normalized ? `/${normalized}` : '/', entries };
  }

  async read(root: string, relPath: string): Promise<TextFileContent> {
    const file = await this.sandbox.resolve(root, relPath);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) throw new AppError('SYMLINK_NOT_ALLOWED', '不允许读取符号链接');
    if (!stat.isFile()) throw new AppError('UNSUPPORTED_FILE', '目标不是普通文件');
    if (stat.size > MAX_TEXT_BYTES) throw new AppError('FILE_TOO_LARGE', '文件超过 2 MB');
    const raw = await fs.readFile(file);
    if (raw.includes(0)) throw new AppError('UNSUPPORTED_FILE', '这是二进制文件');
    const content = raw.toString('utf8');
    return { content, mtime: stat.mtimeMs, eol: content.includes('\r\n') ? '\r\n' : '\n' };
  }

  async save(root: string, relPath: string, content: string, expectedMtime: number): Promise<{ mtime: number }> {
    const file = await this.sandbox.resolve(root, relPath);
    const stat = await fs.lstat(file).catch((error: unknown) => {
      if (isEnoent(error)) throw new AppError('NOT_FOUND', '文件不存在');
      throw error;
    });
    if (stat.isSymbolicLink()) throw new AppError('SYMLINK_NOT_ALLOWED', '不允许写入符号链接');
    if (!stat.isFile()) throw new AppError('UNSUPPORTED_FILE', '目标不是普通文件');
    if (Math.abs(stat.mtimeMs - expectedMtime) > 0.5) {
      throw new AppError('MTIME_CONFLICT', '文件已被外部修改');
    }
    await writeFileAtomic(file, content);
    return { mtime: (await fs.stat(file)).mtimeMs };
  }

  async mkdir(root: string, relPath: string): Promise<void> {
    const normalized = this.sandbox.normalizeRelative(relPath);
    if (!normalized) throw new AppError('VALIDATION_ERROR', '目录名不能为空');
    const target = await this.sandbox.resolve(root, normalized);
    try {
      await fs.mkdir(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw new AppError('VALIDATION_ERROR', '同名文件或目录已存在');
      if (code === 'ENOENT') throw new AppError('VALIDATION_ERROR', '上级目录不存在');
      throw error;
    }
  }

  async rename(root: string, relPath: string, newName: string): Promise<{ path: string }> {
    const normalized = this.sandbox.normalizeRelative(relPath);
    if (!normalized) throw new AppError('VALIDATION_ERROR', '不能重命名实例根目录');
    const parent = path.posix.dirname(normalized);
    const nextRel = parent === '.' ? newName : `${parent}/${newName}`;
    const source = await this.sandbox.resolve(root, normalized);
    const target = await this.sandbox.resolve(root, nextRel);
    const exists = await fs.lstat(target).then(
      () => true,
      (error: unknown) => {
        if (isEnoent(error)) return false;
        throw error;
      },
    );
    if (exists) throw new AppError('VALIDATION_ERROR', '同名文件或目录已存在');
    await fs.rename(source, target);
    return { path: `/${nextRel}` };
  }

  async remove(root: string, relPath: string, recursive: boolean): Promise<void> {
    const normalized = this.sandbox.normalizeRelative(relPath);
    if (!normalized) throw new AppError('VALIDATION_ERROR', '不能删除实例根目录');
    const target = await this.sandbox.resolve(root, normalized);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new AppError('SYMLINK_NOT_ALLOWED', '不允许删除符号链接');
    if (stat.isDirectory() && !recursive) throw new AppError('VALIDATION_ERROR', '删除目录需要递归确认');
    await fs.rm(target, { recursive, force: false });
  }

  async download(root: string, relPath: string): Promise<{ file: string; name: string; size: number }> {
    const file = await this.sandbox.resolve(root, relPath);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) throw new AppError('SYMLINK_NOT_ALLOWED', '不允许下载符号链接');
    if (!stat.isFile()) throw new AppError('UNSUPPORTED_FILE', '只能下载文件');
    return { file, name: path.basename(file), size: stat.size };
  }

  async upload(
    root: string,
    relPath: string,
    filename: string,
    stream: Readable,
    limitBytes: number,
  ): Promise<{ path: string }> {
    const { rel } = await this.resolveDirectory(root, relPath);
    const safeName = filename.replace(/[\\/]/g, '').trim();
    if (!safeName || safeName === '.' || safeName === '..' || safeName.includes('\0')) {
      throw new AppError('VALIDATION_ERROR', '文件名非法');
    }
    const nextRel = rel ? `${rel}/${safeName}` : safeName;
    const target = await this.sandbox.resolve(root, nextRel);
    const targetStat = await fs.lstat(target).catch((error: unknown) => {
      if (isEnoent(error)) return null;
      throw error;
    });
    if (targetStat?.isDirectory()) throw new AppError('VALIDATION_ERROR', '同名目录已存在');

    const tempDir = path.join(root, '.mcpanel-tmp');
    await fs.mkdir(tempDir, { recursive: true });
    const temp = path.join(tempDir, `upload-${randomUUID()}.tmp`);
    let written = 0;
    try {
      await pipeline(
        stream,
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            written += chunk.length;
            if (written > limitBytes) {
              throw new AppError('FILE_TOO_LARGE', `上传超过 ${Math.floor(limitBytes / 1024 / 1024)} MB`);
            }
            yield chunk;
          }
        },
        createWriteStream(temp),
      );
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
    return { path: `/${nextRel}` };
  }

  async unzip(root: string, relPath: string, targetDir?: string): Promise<{ entries: number }> {
    const archivePath = await this.sandbox.resolve(root, relPath);
    const archiveStat = await fs.lstat(archivePath);
    if (archiveStat.isSymbolicLink()) throw new AppError('SYMLINK_NOT_ALLOWED', '不允许解压符号链接');
    if (!archiveStat.isFile()) throw new AppError('ZIP_INVALID', '目标不是文件');

    const sourceRel = this.sandbox.normalizeRelative(relPath);
    const destinationRel = targetDir
      ? this.sandbox.normalizeRelative(targetDir)
      : path.posix.dirname(sourceRel) === '.' ? '' : path.posix.dirname(sourceRel);
    const destination = await this.sandbox.resolve(root, destinationRel);
    await fs.mkdir(destination, { recursive: true });

    const entries = await new Promise<number>((resolve, reject) => {
      yauzl.open(archivePath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
        if (openError || !zip) {
          reject(new AppError('ZIP_INVALID', '压缩包无法打开'));
          return;
        }
        let count = 0;
        let totalBytes = 0;
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
          resolve(count);
        });
        zip.on('entry', (entry: yauzl.Entry) => {
          count += 1;
          totalBytes += entry.uncompressedSize;
          if (count > MAX_ZIP_ENTRIES) return fail(new AppError('ZIP_INVALID', '压缩包条目过多'));
          if (totalBytes > MAX_ZIP_BYTES) return fail(new AppError('ZIP_INVALID', '解压后体积超过 10 GB'));
          if (isUnsafeEntry(entry.fileName)) return fail(new AppError('ZIP_INVALID', '压缩包包含越界路径'));
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (mode === 0o120000) return fail(new AppError('ZIP_INVALID', '压缩包包含符号链接条目'));

          if (entry.fileName.endsWith('/')) {
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (streamError, readStream) => {
            if (streamError || !readStream) {
              fail(streamError ?? new AppError('ZIP_INVALID', '无法读取压缩包条目'));
              return;
            }
            const outRel = destinationRel === '' ? entry.fileName : `${destinationRel}/${entry.fileName}`;
            void this.sandbox
              .resolve(root, outRel)
              .then(async (outFile) => {
                await fs.mkdir(path.dirname(outFile), { recursive: true });
                await pipeline(readStream, createWriteStream(outFile));
                zip.readEntry();
              })
              .catch(fail);
          });
        });
        zip.readEntry();
      });
    });
    return { entries };
  }

  async toggleMod(root: string, relPath: string): Promise<{ path: string }> {
    const normalized = this.sandbox.normalizeRelative(relPath);
    if (!normalized.startsWith('mods/')) throw new AppError('VALIDATION_ERROR', '只有 mods/ 目录下的模组可以启停');
    let nextRel: string;
    if (normalized.endsWith('.jar')) nextRel = `${normalized}.disabled`;
    else if (normalized.endsWith('.jar.disabled')) nextRel = normalized.slice(0, -'.disabled'.length);
    else throw new AppError('VALIDATION_ERROR', '只支持 .jar 与 .jar.disabled 文件');

    const source = await this.sandbox.resolve(root, normalized);
    const target = await this.sandbox.resolve(root, nextRel);
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink()) throw new AppError('SYMLINK_NOT_ALLOWED', '不允许操作符号链接');
    if (!stat.isFile()) throw new AppError('VALIDATION_ERROR', '目标不是文件');
    const exists = await fs.lstat(target).then(
      () => true,
      (error: unknown) => {
        if (isEnoent(error)) return false;
        throw error;
      },
    );
    if (exists) throw new AppError('VALIDATION_ERROR', '目标文件已存在');
    await fs.rename(source, target);
    return { path: `/${nextRel}` };
  }

  async resolveDirectory(root: string, relPath: string): Promise<{ dir: string; rel: string }> {
    const normalized = this.sandbox.normalizeRelative(relPath);
    const dir = await this.sandbox.resolve(root, normalized);
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink()) throw new AppError('SYMLINK_NOT_ALLOWED', '不允许访问符号链接');
    if (!stat.isDirectory()) throw new AppError('VALIDATION_ERROR', '目标不是目录');
    return { dir, rel: normalized };
  }
}
