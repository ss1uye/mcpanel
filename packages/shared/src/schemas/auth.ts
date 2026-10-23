import { z } from 'zod';

export const usernameSchema = z.string().trim().min(3).max(32);
export const passwordSchema = z.string().min(12).max(128);

export const setupSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
});

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(32),
  password: z.string().min(1).max(128),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});
