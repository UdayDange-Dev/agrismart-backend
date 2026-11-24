import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { randomToken, sha256 } from '../lib/crypto.js';
import { AppError, badRequest, conflict, notFound, tooManyRequests } from '../lib/errors.js';
import { DUMMY_HASH, hashPassword, passwordProblem, verifyPassword } from '../lib/password.js';
import { ACTIVITY_INTERVAL_MS } from './userRegistry.js';
import {
  DuplicateKeyError,
  type AccountStatus,
  type AddressFields,
  type CustomerRecord,
  type CustomerRepository,
  type CustomerTokenRepository,
  type SavedAddress,
  type TokenPurpose,
} from '../repositories/types.js';
import { describeMailError, templates, type Mailer, type MailMessage } from './mailer.js';
import { invalidCredentials, LOCKOUT_MS, MAX_FAILED_LOGINS } from './authService.js';
import type { SessionManager } from './sessionManager.js';

export const TOKEN_TTL_MS: Record<TokenPurpose, number> = {
  verify_email: 24 * 60 * 60 * 1000,
  change_email: 24 * 60 * 60 * 1000,
  reset_password: 30 * 60 * 1000,
};
/** Per-account cap on emails of each kind per hour (on top of per-IP rate limits). */
export const MAX_TOKENS_PER_HOUR = 3;
export const MAX_ADDRESSES = 5;

const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const invalidLink = () => new AppError(400, 'invalid_token', 'This link is invalid or has expired. Please request a new one.');

/** The only customer fields ever returned to the browser. */
export interface CustomerView {
  email: string;
  name: string;
  phone: string;
  emailVerified: boolean;
  createdAt: string;
}

export const toCustomerView = (c: CustomerRecord): CustomerView => ({
  email: c.email,
  name: c.name,
  phone: c.phone,
  emailVerified: c.emailVerified,
  createdAt: c.createdAt.toISOString(),
});

export class CustomerAuthService {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly tokens: CustomerTokenRepository,
    private readonly sessions: SessionManager,
    private readonly mailer: Mailer,
    private readonly opts: { publicUrl: URL },
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ---------------------------------------------------------------- helpers

  private link(path: string, token?: string): string {
    // Tokens travel in the URL fragment: never sent to servers, proxies or logs, nor in Referer.
    return `${this.opts.publicUrl.origin}${path}${token ? `#token=${token}` : ''}`;
  }

  /** Emails are sent without awaiting, so response timing does not reveal whether an account exists. */
  private deliver(to: string, message: Omit<MailMessage, 'to'>, kind: string): void {
    this.mailer.send({ to, ...message }).catch((err: unknown) => {
      // No recipient address, token or raw SMTP message in logs.
      this.logger.error({ kind, err: describeMailError(err) }, 'Failed to send account email');
    });
  }

  private async issueToken(customerId: string, purpose: TokenPurpose, newEmail: string | null = null): Promise<string> {
    const now = this.now();
    await this.tokens.invalidate(customerId, purpose, now); // only the newest link works
    const token = randomToken(32);
    await this.tokens.create({
      tokenHash: sha256(token),
      customerId,
      purpose,
      newEmail,
      expiresAt: new Date(now.getTime() + TOKEN_TTL_MS[purpose]),
    });
    return token;
  }

  private async underHourlyCap(customerId: string, purpose: TokenPurpose): Promise<boolean> {
    const since = new Date(this.now().getTime() - 60 * 60 * 1000);
    return (await this.tokens.countIssuedSince(customerId, purpose, since)) < MAX_TOKENS_PER_HOUR;
  }

  private assertStrong(password: string, ctx: { email?: string; name?: string }, field = 'password'): void {
    const problem = passwordProblem(password, ctx);
    if (problem) throw new AppError(400, 'validation_error', 'The request contains invalid data', [{ path: field, message: problem }]);
  }

  /** Verifies the current password for sensitive changes; failures count towards lockout. */
  private async reauthenticate(customer: CustomerRecord, password: string): Promise<void> {
    const now = this.now();
    const ok = await verifyPassword(password, customer.passwordHash);
    const locked = customer.lockedUntil !== null && customer.lockedUntil > now;
    if (ok && !locked) return;
    if (!ok) {
      const lockNow = customer.failedLoginCount + 1 >= MAX_FAILED_LOGINS;
      await this.customers.recordFailedLogin(customer.id, lockNow ? new Date(now.getTime() + LOCKOUT_MS) : null);
    }
    throw new AppError(403, 'reauth_failed', 'Your current password is incorrect.');
  }

  private async mustGet(customerId: string): Promise<CustomerRecord> {
    const customer = await this.customers.findById(customerId);
    if (!customer) throw new AppError(401, 'unauthorized', 'Authentication required');
    return customer;
  }

  // ---------------------------------------------------------------- registration & verification

  /**
   * Always resolves the same way whether or not the email is already registered, so the
   * endpoint cannot be used to discover accounts. The owner of an existing address gets a
   * notice email instead of a second account.
   */
  async register(input: { name: string; email: string; phone: string; password: string }): Promise<void> {
    this.assertStrong(input.password, { email: input.email, name: input.name });
    const passwordHash = await hashPassword(input.password); // hashed in both branches: equal timing
    let customer: CustomerRecord;
    try {
      customer = await this.customers.create({ email: input.email, name: input.name, phone: input.phone, passwordHash });
    } catch (err) {
      if (!(err instanceof DuplicateKeyError)) throw err;
      this.deliver(input.email, templates.alreadyRegistered(this.link('/signin'), this.link('/forgot-password')), 'already_registered');
      this.logger.info('Registration attempted for an existing email');
      return;
    }
    const token = await this.issueToken(customer.id, 'verify_email');
    this.deliver(customer.email, templates.verifyEmail(customer.name, this.link('/verify-email', token), 24), 'verify_email');
    this.logger.info({ customerId: customer.id }, 'Customer registered');
  }

  async resendVerification(customerId: string): Promise<void> {
    const customer = await this.mustGet(customerId);
    if (customer.emailVerified) return;
    if (!(await this.underHourlyCap(customer.id, 'verify_email'))) {
      throw tooManyRequests('Please wait before requesting another verification email.');
    }
    const token = await this.issueToken(customer.id, 'verify_email');
    this.deliver(customer.email, templates.verifyEmail(customer.name, this.link('/verify-email', token), 24), 'verify_email');
  }

  /** Confirms either a new account's email or a requested email change. */
  async confirmEmail(token: string): Promise<'verified' | 'email_changed'> {
    if (!TOKEN_FORMAT.test(token)) throw invalidLink();
    const now = this.now();
    const record = await this.tokens.consume(sha256(token), ['verify_email', 'change_email'], now);
    if (!record) throw invalidLink();
    const customer = await this.customers.findById(record.customerId);
    if (!customer) throw invalidLink();

    if (record.purpose === 'verify_email') {
      await this.customers.markEmailVerified(customer.id, now); // also queues the registry update
      await this.noteActivity(customer.id);
      this.logger.info({ customerId: customer.id }, 'Customer email verified');
      return 'verified';
    }
    if (!record.newEmail) throw invalidLink();
    try {
      await this.customers.changeEmail(customer.id, record.newEmail, now);
    } catch (err) {
      if (err instanceof DuplicateKeyError) throw conflict('That email address is already used by another account.');
      throw err;
    }
    this.deliver(customer.email, templates.emailChanged(customer.name, record.newEmail), 'email_changed');
    this.logger.info({ customerId: customer.id }, 'Customer email changed');
    return 'email_changed';
  }

  // ---------------------------------------------------------------- sign in / out

  async login(email: string, password: string): Promise<{ token: string; customer: CustomerRecord; expiresAt: Date }> {
    const customer = await this.customers.findByEmail(email);
    if (!customer) {
      await verifyPassword(password, DUMMY_HASH);
      throw invalidCredentials();
    }
    const now = this.now();
    const locked = customer.lockedUntil !== null && customer.lockedUntil > now;
    const ok = await verifyPassword(password, customer.passwordHash);
    if (locked) throw invalidCredentials();
    if (!ok) {
      const lockNow = customer.failedLoginCount + 1 >= MAX_FAILED_LOGINS;
      await this.customers.recordFailedLogin(customer.id, lockNow ? new Date(now.getTime() + LOCKOUT_MS) : null);
      throw invalidCredentials();
    }
    await this.customers.resetFailedLogins(customer.id);
    // Only revealed after the correct password, so it does not help account enumeration.
    if (customer.accountStatus !== 'active') {
      throw new AppError(403, 'account_disabled', 'This account is not active. Please contact AGRI SMART for help.');
    }
    const { token, expiresAt } = await this.sessions.create('customer', customer.id);
    await this.customers.recordLogin(customer.id, now); // Last Login + Last Activity (registry)
    this.logger.info({ customerId: customer.id }, 'Customer signed in');
    return { token, customer, expiresAt };
  }

  /**
   * Re-reads the customer on every request so changes (verification, suspension) apply
   * immediately. Inactive and suspended accounts have no valid session.
   */
  async authenticate(token: unknown): Promise<CustomerRecord | null> {
    const session = await this.sessions.resolve('customer', token);
    if (!session) return null;
    const customer = await this.customers.findById(session.subjectId);
    return customer?.accountStatus === 'active' ? customer : null;
  }

  /**
   * Records a meaningful action (order, inquiry, account change) as the customer's Last Activity,
   * at most once per ACTIVITY_INTERVAL_MS. Browsing and page loads are deliberately not counted.
   * Never fails the action it accompanies.
   */
  async noteActivity(customerId: string): Promise<void> {
    try {
      await this.customers.recordActivity(customerId, this.now(), ACTIVITY_INTERVAL_MS);
    } catch (err) {
      this.logger.warn({ customerId, err: { name: (err as Error)?.name } }, 'Could not record customer activity');
    }
  }

  /** Staff-only (server CLI): enable, deactivate or suspend an account. Ends its sessions unless active. */
  async setAccountStatus(email: string, status: AccountStatus): Promise<CustomerRecord> {
    const customer = await this.customers.findByEmail(email);
    if (!customer) throw notFound('No customer with that email');
    const updated = await this.customers.setAccountStatus(customer.id, status, this.now());
    if (!updated) throw notFound('No customer with that email');
    if (status !== 'active') await this.sessions.destroyAll('customer', customer.id);
    this.logger.info({ customerId: customer.id, status }, 'Customer account status changed');
    return updated;
  }

  logout(token: unknown): Promise<void> {
    return this.sessions.destroy(token);
  }

  // ---------------------------------------------------------------- password recovery

  /** Always succeeds from the caller's point of view; never reveals whether the email exists. */
  async forgotPassword(email: string): Promise<void> {
    const customer = await this.customers.findByEmail(email);
    if (!customer) return;
    if (!(await this.underHourlyCap(customer.id, 'reset_password'))) {
      this.logger.warn({ customerId: customer.id }, 'Password reset email cap reached');
      return;
    }
    const token = await this.issueToken(customer.id, 'reset_password');
    this.deliver(customer.email, templates.resetPassword(customer.name, this.link('/reset-password', token), 30), 'reset_password');
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    if (!TOKEN_FORMAT.test(token)) throw invalidLink();
    const tokenHash = sha256(token);
    const now = this.now();
    // Validate everything before consuming, so a rejected password does not burn the link.
    const pending = await this.tokens.findActive(tokenHash, ['reset_password'], now);
    if (!pending) throw invalidLink();
    const owner = await this.customers.findById(pending.customerId);
    if (!owner) throw invalidLink();
    this.assertStrong(newPassword, { email: owner.email, name: owner.name });
    const record = await this.tokens.consume(tokenHash, ['reset_password'], now);
    if (!record) throw invalidLink(); // lost a race with a concurrent use
    const customer = owner;
    await this.customers.updatePassword(customer.id, await hashPassword(newPassword));
    // Receiving the reset email proves ownership of the address.
    await this.customers.markEmailVerified(customer.id, now);
    await this.sessions.destroyAll('customer', customer.id);
    this.deliver(customer.email, templates.passwordChanged(customer.name), 'password_changed');
    this.logger.info({ customerId: customer.id }, 'Customer password reset; all sessions revoked');
  }

  // ---------------------------------------------------------------- profile

  // ---------------------------------------------------------------- address book (own record only)

  async listAddresses(customerId: string): Promise<SavedAddress[]> {
    return (await this.mustGet(customerId)).addresses;
  }

  async addAddress(customerId: string, fields: AddressFields): Promise<SavedAddress> {
    const saved = await this.customers.addAddress(customerId, { id: randomUUID(), ...fields }, MAX_ADDRESSES);
    if (!saved) throw conflict(`You can save up to ${MAX_ADDRESSES} addresses. Remove one to add another.`);
    await this.noteActivity(customerId);
    return saved;
  }

  async updateAddress(customerId: string, id: string, fields: AddressFields): Promise<SavedAddress> {
    const saved = await this.customers.updateAddress(customerId, { id, ...fields });
    // Same 404 for "no such id" and "another customer's id".
    if (!saved) throw notFound('Address not found');
    await this.noteActivity(customerId);
    return saved;
  }

  async deleteAddress(customerId: string, id: string): Promise<void> {
    if (!(await this.customers.deleteAddress(customerId, id))) throw notFound('Address not found');
    await this.noteActivity(customerId);
  }

  async updateProfile(customerId: string, patch: { name?: string; phone?: string }): Promise<CustomerRecord> {
    await this.noteActivity(customerId);
    const updated = await this.customers.updateProfile(customerId, patch);
    if (!updated) throw new AppError(401, 'unauthorized', 'Authentication required');
    return updated;
  }

  async changePassword(customerId: string, currentSessionToken: string, currentPassword: string, newPassword: string): Promise<void> {
    const customer = await this.mustGet(customerId);
    await this.reauthenticate(customer, currentPassword);
    this.assertStrong(newPassword, { email: customer.email, name: customer.name }, 'newPassword');
    if (await verifyPassword(newPassword, customer.passwordHash)) {
      throw badRequest('Choose a password different from your current one.');
    }
    await this.customers.updatePassword(customer.id, await hashPassword(newPassword));
    await this.sessions.destroyAll('customer', customer.id, currentSessionToken); // sign out other devices
    await this.noteActivity(customer.id);
    this.deliver(customer.email, templates.passwordChanged(customer.name), 'password_changed');
    this.logger.info({ customerId: customer.id }, 'Customer changed password');
  }

  /** Sends a confirmation link to the new address; the change only happens once it is clicked. */
  async requestEmailChange(customerId: string, currentPassword: string, newEmail: string): Promise<void> {
    const customer = await this.mustGet(customerId);
    await this.reauthenticate(customer, currentPassword);
    if (newEmail === customer.email) throw badRequest('That is already your email address.');
    if (!(await this.underHourlyCap(customer.id, 'change_email'))) {
      throw tooManyRequests('Please wait before requesting another email change.');
    }
    const token = await this.issueToken(customer.id, 'change_email', newEmail);
    this.deliver(newEmail, templates.changeEmail(customer.name, this.link('/verify-email', token), 24), 'change_email');
  }
}
