import { AppError } from '../lib/errors.js';
import { DUMMY_HASH, verifyPassword } from '../lib/password.js';
import type { Role, UserRecord, UserRepository } from '../repositories/types.js';
import type { SessionManager } from './sessionManager.js';

export { BCRYPT_COST, hashPassword } from '../lib/password.js';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

export const invalidCredentials = () => new AppError(401, 'invalid_credentials', 'Invalid email or password');

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
}

/** Back-office (staff/admin) authentication. Accounts are provisioned only via `npm run create-admin`. */
export class AuthService {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionManager,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async login(email: string, password: string): Promise<{ token: string; user: AuthenticatedUser; expiresAt: Date }> {
    const user = await this.users.findByEmail(email);
    if (!user) {
      await verifyPassword(password, DUMMY_HASH);
      throw invalidCredentials();
    }
    const now = this.now();
    const locked = user.lockedUntil !== null && user.lockedUntil > now;
    const ok = await verifyPassword(password, user.passwordHash);
    // Locked or disabled accounts get the same generic error as a wrong password.
    if (locked || user.disabled) throw invalidCredentials();
    if (!ok) {
      const lockNow = user.failedLoginCount + 1 >= MAX_FAILED_LOGINS;
      await this.users.recordFailedLogin(user.id, lockNow ? new Date(now.getTime() + LOCKOUT_MS) : null);
      throw invalidCredentials();
    }
    await this.users.resetFailedLogins(user.id);
    const { token, expiresAt } = await this.sessions.create('staff', user.id);
    return { token, user: toAuthUser(user), expiresAt };
  }

  /** Resolves the session and re-reads the user, so disabling a user or changing a role applies immediately. */
  async authenticate(token: unknown): Promise<AuthenticatedUser | null> {
    const session = await this.sessions.resolve('staff', token);
    if (!session) return null;
    const user = await this.users.findById(session.subjectId);
    if (!user || user.disabled) return null;
    return toAuthUser(user);
  }

  logout(token: unknown): Promise<void> {
    return this.sessions.destroy(token);
  }
}

const toAuthUser = (u: UserRecord): AuthenticatedUser => ({ id: u.id, email: u.email, role: u.role });
