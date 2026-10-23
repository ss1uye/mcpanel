import argon2 from 'argon2';
import { AppError } from '../utils/errors';

const OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function validatePassword(password: string): void {
  if (password.length < 12) throw new AppError('VALIDATION_ERROR', '密码至少 12 个字符');
  if (password.length > 128) throw new AppError('VALIDATION_ERROR', '密码最多 128 个字符');
}

export function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  return argon2.hash(password, OPTIONS);
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password).catch(() => false);
}
