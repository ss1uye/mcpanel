import { describe, expect, it } from 'vitest';
import { hashPassword, validatePassword, verifyPassword } from '../../src/auth/password';

describe('password', () => {
  it('hashes and verifies with argon2id', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'wrong password')).toBe(false);
  });

  it('enforces 12-128 characters', () => {
    expect(() => validatePassword('short')).toThrow(/12/);
    expect(() => validatePassword('a'.repeat(129))).toThrow(/128/);
    expect(() => validatePassword('a'.repeat(12))).not.toThrow();
  });
});
