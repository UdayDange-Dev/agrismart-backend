import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SessionPolicy } from '../config/env.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import type { SessionKind, SessionRecord, SessionRepository } from '../repositories/types.js';

const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
/** Avoid a database write on every request: refresh lastSeenAt at most this often. */
const TOUCH_INTERVAL_MS = 60 * 1000;

export const isSessionTokenFormat = (token: unknown): token is string => typeof token === 'string' && TOKEN_FORMAT.test(token);

/**
 * CSRF token bound to a session: HMAC(sessionToken, label). An attacker cannot compute it
 * without the HttpOnly session cookie, and nothing extra needs to be stored server-side.
 */
export function csrfTokenFor(sessionToken: string): string {
  return createHmac('sha256', sessionToken).update('agrismart-csrf-v1').digest('base64url');
}

export function verifyCsrfToken(sessionToken: string, presented: unknown): boolean {
  if (typeof presented !== 'string' || presented.length !== 43) return false;
  const expected = Buffer.from(csrfTokenFor(sessionToken));
  const actual = Buffer.from(presented);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Server-side sessions: the cookie holds a random 256-bit token, the database only its
 * SHA-256 hash. Sessions end at an absolute expiry or after an idle period, whichever is first.
 */
export class SessionManager {
  constructor(
    private readonly repo: SessionRepository,
    private readonly policies: Record<SessionKind, SessionPolicy>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  policy(kind: SessionKind): SessionPolicy {
    return this.policies[kind];
  }

  async create(kind: SessionKind, subjectId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomToken(32);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.policies[kind].ttlMs);
    await this.repo.create({ tokenHash: sha256(token), kind, subjectId, expiresAt, lastSeenAt: now });
    return { token, expiresAt };
  }

  async resolve(kind: SessionKind, token: unknown): Promise<SessionRecord | null> {
    if (!isSessionTokenFormat(token)) return null;
    const now = this.now();
    const hash = sha256(token);
    const session = await this.repo.findValid(hash, kind, now);
    if (!session) return null;
    if (now.getTime() - session.lastSeenAt.getTime() > this.policies[kind].idleMs) {
      await this.repo.delete(hash);
      return null;
    }
    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) await this.repo.touch(hash, now);
    return session;
  }

  async destroy(token: unknown): Promise<void> {
    if (isSessionTokenFormat(token)) await this.repo.delete(sha256(token));
  }

  /** Revoke all sessions of a subject (e.g. after a password reset), optionally keeping the current one. */
  async destroyAll(kind: SessionKind, subjectId: string, keepToken?: string): Promise<void> {
    await this.repo.deleteBySubject(kind, subjectId, keepToken ? sha256(keepToken) : undefined);
  }
}
