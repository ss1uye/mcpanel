import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RootValidation } from '@mcpanel/shared';
import { AppError } from '../utils/errors';

export function toRootKey(realPath: string): string {
  const normalized = path.resolve(realPath).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithin(parent: string, child: string): boolean {
  const p = process.platform === 'win32' ? parent.toLowerCase() : parent;
  const c = process.platform === 'win32' ? child.toLowerCase() : child;
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

export class PathSandbox {
  constructor(private readonly dataDir: string) {}

  async validateRoot(rootPath: string, otherRoots: string[]): Promise<RootValidation> {
    let real: string;
    try {
      real = await fs.realpath(path.resolve(rootPath));
    } catch {
      throw new AppError('INVALID_ROOT', '目录不存在或无法访问');
    }
    if (!(await fs.stat(real)).isDirectory()) throw new AppError('INVALID_ROOT', '不是目录');
    if (path.parse(real).root === real) throw new AppError('INVALID_ROOT', '不能使用文件系统根目录');
    const home = await fs.realpath(os.homedir()).catch(() => os.homedir());
    if (toRootKey(real) === toRootKey(home)) throw new AppError('INVALID_ROOT', '不能使用用户主目录');
    try {
      await fs.access(real, fsSync.constants.R_OK | fsSync.constants.W_OK);
    } catch {
      throw new AppError('INVALID_ROOT', '目录不可读写');
    }

    const dataReal = await fs.realpath(this.dataDir).catch(() => path.resolve(this.dataDir));
    if (isWithin(real, dataReal) || isWithin(dataReal, real)) {
      throw new AppError('ROOT_OVERLAPS', '实例目录与面板数据目录重叠');
    }
    for (const other of otherRoots) {
      const otherReal = await fs.realpath(other).catch(() => path.resolve(other));
      if (isWithin(real, otherReal) || isWithin(otherReal, real)) {
        throw new AppError('ROOT_OVERLAPS', '实例目录与其他实例重叠');
      }
    }
    return { realPath: real, rootKey: toRootKey(real) };
  }

  async resolve(root: string, relPath: string): Promise<string> {
    const canonicalRoot = path.resolve(root);
    let realRoot: string;
    try {
      realRoot = await fs.realpath(canonicalRoot);
    } catch {
      throw new AppError('INVALID_ROOT', '实例根目录不存在或无法访问');
    }
    if (toRootKey(realRoot) !== toRootKey(canonicalRoot)) {
      await this.assertCanonicalRoot(canonicalRoot);
    }
    // The lstat walk below is check-then-use: callers performing writes must not
    // assume atomic protection against a concurrent symlink swap (Node lacks O_NOFOLLOW).
    const normalized = this.normalizeRelative(relPath);
    const target = path.resolve(canonicalRoot, ...normalized.split('/').filter(Boolean));
    if (!isWithin(canonicalRoot, target)) throw new AppError('PATH_OUTSIDE_ROOT', '路径越界');
    await this.assertNoSymlink(canonicalRoot, target);
    return target;
  }

  normalizeRelative(relPath: string): string {
    if (relPath.includes('\0')) throw new AppError('PATH_OUTSIDE_ROOT', '路径非法');
    const replaced = relPath.replaceAll('\\', '/');
    if (replaced.startsWith('//')) throw new AppError('PATH_OUTSIDE_ROOT', '路径越界');
    const stripped = replaced.replace(/^\/+/, '');
    if (/^[A-Za-z]:/.test(stripped)) throw new AppError('PATH_OUTSIDE_ROOT', '路径越界');
    const normalized = path.posix.normalize(stripped);
    if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
      throw new AppError('PATH_OUTSIDE_ROOT', '路径越界');
    }
    if (process.platform === 'win32') {
      for (const segment of normalized.split('/')) {
        // Reject NTFS alternate data streams and trailing dot/space aliases.
        if (segment.includes(':') || segment.endsWith('.') || segment.endsWith(' ')) {
          throw new AppError('PATH_OUTSIDE_ROOT', '路径非法');
        }
      }
    }
    return normalized === '.' ? '' : normalized;
  }

  private async assertCanonicalRoot(canonicalRoot: string): Promise<void> {
    // Windows realpath() expands 8.3 short names (e.g. ADMINI~1), so a safe
    // directory can differ from its canonical spelling. Accept the difference
    // only when no component of the supplied root is a symlink or junction.
    try {
      await this.assertNoSymlink(path.parse(canonicalRoot).root, canonicalRoot);
    } catch (error) {
      if (error instanceof AppError && error.code === 'SYMLINK_NOT_ALLOWED') {
        throw new AppError('SYMLINK_NOT_ALLOWED', '实例根目录已被替换或不是规范路径');
      }
      throw error;
    }
  }

  private async assertNoSymlink(root: string, target: string): Promise<void> {
    const relative = path.relative(root, target);
    if (relative === '') return;
    let current = root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try {
        if ((await fs.lstat(current)).isSymbolicLink()) throw new AppError('SYMLINK_NOT_ALLOWED', '路径包含符号链接');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
    }
  }
}
