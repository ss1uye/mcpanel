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

  it('rejects hashing passwords shorter than 12 characters', () => {
    expect(() => hashPassword('short')).toThrow(/12/);
    expect(() => hashPassword('a'.repeat(11))).toThrow(/12/);
  });

  it('uses a unique salt for every hash of the same password', async () => {
    const first = await hashPassword('correct horse battery');
    const second = await hashPassword('correct horse battery');
    expect(first).not.toBe(second);
    expect(await verifyPassword(first, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(second, 'correct horse battery')).toBe(true);
  });

  it('returns false for a malformed hash', async () => {
    await expect(verifyPassword('not-a-valid-argon2-hash', 'correct horse battery')).resolves.toBe(false);
  });
});
