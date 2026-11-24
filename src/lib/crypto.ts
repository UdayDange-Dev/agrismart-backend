import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** Human-friendly reference without ambiguous characters (no 0/O/1/I). */
export function randomReference(prefix: string, length = 10): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, so modulo is unbiased
  let out = '';
  for (const b of randomBytes(length)) out += alphabet[b % alphabet.length];
  return `${prefix}-${out}`;
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}
