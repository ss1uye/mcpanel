import { z } from 'zod';

const NUL = '\0';

function hasUnsafeSegments(value: string): boolean {
  const replaced = value.replaceAll('\\', '/');
  if (/^[A-Za-z]:/.test(replaced)) return true;
  for (const segment of replaced.split('/')) {
    if (segment === '..') return true;
  }
  return false;
}

export const filePathSchema = z
  .string()
  .max(4096)
  .optional()
  .transform((value) => value ?? '/')
  .refine((value) => !value.includes(NUL), '路径非法')
  .refine((value) => !hasUnsafeSegments(value), '路径越界');

export const saveFileSchema = z.object({
  path: z.string().min(1).max(4096).refine((value) => !value.includes(NUL), '路径非法'),
  content: z.string().max(2 * 1024 * 1024, '文件超过 2 MB'),
  expectedMtime: z.number().nonnegative(),
});

const fileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !/[\\/]/.test(value) && value !== '.' && value !== '..' && !value.includes(NUL), '文件名非法');

export const mkdirSchema = z.object({ path: z.string().min(1).max(4096) });
export const renameSchema = z.object({ path: z.string().min(1).max(4096), newName: fileNameSchema });
export const deleteFileSchema = z.object({ path: z.string().min(1).max(4096), recursive: z.boolean().default(false) });
export const unzipSchema = z.object({
  path: z.string().min(1).max(4096),
  targetDir: z.string().max(4096).optional(),
});
export const modsToggleSchema = z.object({ path: z.string().min(1).max(4096) });

export const propertiesSaveSchema = z.object({
  changes: z.record(z.string().min(1).max(120), z.string().max(4096)),
  expectedMtime: z.number().nonnegative(),
});

export const eulaSchema = z.object({ accept: z.literal(true) });
