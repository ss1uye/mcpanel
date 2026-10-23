import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const logsQuerySchema = z.object({
  lines: z.coerce.number().int().min(1).max(2000).default(200),
});

export const auditQuerySchema = paginationSchema.extend({
  action: z.string().trim().max(80).optional(),
});
