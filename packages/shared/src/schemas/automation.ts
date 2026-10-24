import { z } from 'zod';
import { SCHEDULE_ACTIONS } from '../constants';

const timezone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, '时区无效');

const command = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine((value) => !/[\r\n]/.test(value), '命令不能包含换行');

const message = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !/[\r\n]/.test(value), '消息不能包含换行');

export const createScheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    cron: z.string().trim().min(1).max(120),
    timezone,
    actionType: z.enum(SCHEDULE_ACTIONS),
    command: command.optional(),
    message: message.optional(),
    enabled: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.actionType === 'command' && value.command === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['command'], message: 'command 动作需要命令内容' });
    }
    if (value.actionType === 'broadcast' && value.message === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['message'], message: 'broadcast 动作需要广播内容' });
    }
  });

export const updateScheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    cron: z.string().trim().min(1).max(120),
    timezone,
    actionType: z.enum(SCHEDULE_ACTIONS),
    command: command.nullable(),
    message: message.nullable(),
    enabled: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个要修改的字段' });

export const restoreBackupSchema = z.object({ confirm: z.literal(true) });

export const schedulePreviewSchema = z.object({
  cron: z.string().trim().min(1).max(120),
  timezone,
});
