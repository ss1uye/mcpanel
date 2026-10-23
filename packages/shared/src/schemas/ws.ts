import { z } from 'zod';

export const wsClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subscribe'),
    channel: z.string().min(1).max(120),
    sinceSeq: z.number().int().min(0).optional(),
  }),
  z.object({ type: z.literal('unsubscribe'), channel: z.string().min(1).max(120) }),
  z.object({ type: z.literal('ping') }),
]);
