import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';

/** bcrypt work factor (2^12 rounds, roughly 200-300 ms per hash on a small VPS). */
export const BCRYPT_COST = 12;

/**
 * bcrypt only uses the first 72 bytes of input, so the password is pre-hashed with
 * SHA-256 (base64, 44 bytes) before bcrypt. This keeps long passphrases meaningful.
 */
const prehash = (password: string) => createHash('sha256').update(password.normalize('NFC'), 'utf8').digest('base64');

export const hashPassword = (password: string): Promise<string> => bcrypt.hash(prehash(password), BCRYPT_COST);
export const verifyPassword = (password: string, hash: string): Promise<boolean> => bcrypt.compare(prehash(password), hash);

/** Used to spend the same time on unknown accounts as on real ones (account enumeration defence). */
export const DUMMY_HASH = bcrypt.hashSync(prehash('timing-equaliser'), BCRYPT_COST);

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

// Small list of passwords that satisfy the composition rules but are still commonly guessed.
const COMMON = new Set(
  [
    'password1234',
    'password@123',
    'Password1234',
    'Password@123',
    'Welcome@1234',
    'Qwerty123456',
    'Admin@123456',
    'Agrismart123',
    'Agrismart@123',
    'Abcd@1234567',
    'Iloveyou1234',
    'India@123456',
  ].map((p) => p.toLowerCase()),
);

/** Returns a user-facing problem description, or null if the password is acceptable. */
export function passwordProblem(password: string, context: { email?: string; name?: string } = {}): string | null {
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters`;
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password needs upper and lower case letters and a number';
  }
  if (/^(.)\1+$/.test(password) || COMMON.has(password.toLowerCase())) return 'This password is too common';
  const lower = password.toLowerCase();
  const local = context.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) return 'Password must not contain your email address';
  const firstName = context.name?.split(/\s+/)[0]?.toLowerCase();
  if (firstName && firstName.length >= 4 && lower.includes(firstName)) return 'Password must not contain your name';
  return null;
}
