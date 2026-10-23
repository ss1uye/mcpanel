import { z } from 'zod';
import { LOG_ENCODINGS } from '../constants';

const javaPathSchema = z.string().trim().min(1).max(4096).nullable();
const rconHostSchema = z.string().trim().min(1).max(255).nullable();

export const createInstanceSchema = z.object({
  name: z.string().trim().min(1).max(60),
  rootPath: z.string().min(1).max(4096),
  startCommand: z.string().trim().min(1).max(2000),
  javaPath: javaPathSchema.default(null),
  stopTimeoutSec: z.number().int().min(10).max(300).default(30),
  logEncoding: z.enum(LOG_ENCODINGS).default('utf-8'),
  rconHost: rconHostSchema.default(null),
  backupKeep: z.number().int().min(1).max(100).default(10),
  backupIncludeMods: z.boolean().default(false),
  backupIncludeConfig: z.boolean().default(true),
  backupExtraPaths: z.array(z.string().min(1).max(512)).max(20).default([]),
});

export const updateInstanceSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    startCommand: z.string().trim().min(1).max(2000),
    javaPath: javaPathSchema,
    stopTimeoutSec: z.number().int().min(10).max(300),
    logEncoding: z.enum(LOG_ENCODINGS),
    rconHost: rconHostSchema,
    backupKeep: z.number().int().min(1).max(100),
    backupIncludeMods: z.boolean(),
    backupIncludeConfig: z.boolean(),
    backupExtraPaths: z.array(z.string().min(1).max(512)).max(20),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个要修改的字段' });

export const probeSchema = z.object({ rootPath: z.string().min(1).max(4096) });
export const deleteInstanceSchema = z.object({ confirmName: z.string().min(1).max(60) });
export const markStoppedSchema = z.object({ confirm: z.literal(true) });
export const consoleCommandSchema = z.object({
  command: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .refine((value) => !/[\r\n]/.test(value), { message: '命令不能包含换行' }),
});
