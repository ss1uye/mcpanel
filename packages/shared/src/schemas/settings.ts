import { z } from 'zod';

const timeZone = z
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

export const panelSettingsSchema = z.object({
  panelName: z.string().trim().min(1).max(60),
  defaultTimezone: timeZone,
  auditRetentionDays: z.number().int().min(1).max(3650),
});

export const panelSettingsPatchSchema = panelSettingsSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个要修改的字段' });
