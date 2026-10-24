import { z } from 'zod';

const playerName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_]{1,16}$/, '玩家名不合法');

const reason = z
  .string()
  .trim()
  .max(200)
  .transform((value) => value.replace(/[\r\n]+/g, ' ').trim())
  .default('');

const message = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .transform((value) => value.replace(/[\r\n]+/g, ' ').trim());

export const playerActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('op'), player: playerName }),
  z.object({ action: z.literal('deop'), player: playerName }),
  z.object({ action: z.literal('whitelist_add'), player: playerName }),
  z.object({ action: z.literal('whitelist_remove'), player: playerName }),
  z.object({ action: z.literal('pardon'), player: playerName }),
  z.object({ action: z.literal('kick'), player: playerName, reason }),
  z.object({ action: z.literal('ban'), player: playerName, reason }),
  z.object({
    action: z.literal('gamemode'),
    player: playerName,
    mode: z.enum(['survival', 'creative', 'adventure', 'spectator']),
  }),
  z.object({ action: z.literal('broadcast'), message }),
  z.object({ action: z.literal('whitelist_on') }),
  z.object({ action: z.literal('whitelist_off') }),
]);

export type PlayerActionInput = z.infer<typeof playerActionSchema>;
