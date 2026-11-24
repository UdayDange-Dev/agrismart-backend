import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../src/config/env.js';
import { hashPassword } from '../src/services/authService.js';
import type { MemoryMailer } from '../src/services/mailer.js';
import { ALLOWED_ORIGIN, buildTestApp, EVIL_ORIGIN, startStubErp, type StubErp } from './helpers.js';

let erp: StubErp;
beforeAll(async () => {
  erp = await startStubErp();
});
afterAll(() => erp.close());

const PASSWORD = 'Green-Fields-2026';
const person = (n = 1) => ({
  name: `Kavya Rao`,
  email: `kavya${n}@example.com`,
  phone: `+91 98765 4321${n % 10}`,
  password: PASSWORD,
  confirmPassword: PASSWORD,
});

function setup(configure?: (c: Config) => void) {
  const ctx = buildTestApp(erp.url, { configure });
  const app = ctx.app;
  const post = (path: string, body?: unknown, agent = request.agent(app)) =>
    agent.post(`/api/customer${path}`).set('Origin', ALLOWED_ORIGIN).send(body as object);

  const lastToken = (to: string, subject: RegExp) => {
    const mail = [...ctx.mailer.outbox].reverse().find((m) => m.to === to && subject.test(m.subject));
    const token = mail?.text.match(/#token=([A-Za-z0-9_-]{43})/)?.[1];
    if (!token) throw new Error(`no ${subject} email for ${to}`);
    return token;
  };

  /** Registers, verifies the email, signs in. Returns an agent holding the session cookie plus its CSRF token. */
  const signedIn = async (n = 1, { verify = true } = {}) => {
    const p = person(n);
    expect((await post('/auth/register', p)).status).toBe(202);
    if (verify) expect((await post('/auth/verify-email', { token: lastToken(p.email, /Confirm your Agrismart/) })).status).toBe(200);
    const agent = request.agent(app);
    const res = await post('/auth/login', { email: p.email, password: PASSWORD }, agent);
    expect(res.status).toBe(200);
    return { agent, csrf: res.body.csrfToken as string, person: p, res };
  };
  return { ...ctx, post, lastToken, signedIn, mailer: ctx.mailer as MemoryMailer };
}

const sessionCookie = (res: request.Response, name = 'agrismart_customer') =>
  ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`)) ?? '';

const order = (items = [{ itemCode: 'SEED-001', qty: 1 }]) => ({
  customer: { name: 'Kavya Rao', phone: '9876543210' },
  shippingAddress: { line1: '1 Orchard Lane', city: 'Nashik', state: 'Maharashtra', postalCode: '422001' },
  items,
  acceptTerms: true,
});

describe('registration', () => {
  it('registers, emails a verification link and stores only a bcrypt hash', async () => {
    const { post, repos, mailer, logs } = setup();
    const res = await post('/auth/register', person());
    expect(res.status).toBe(202);
    const stored = await repos.customers.findByEmail('kavya1@example.com');
    expect(stored).toMatchObject({ name: 'Kavya Rao', phone: '+919876543211', emailVerified: false });
    expect(stored!.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(JSON.stringify([...repos.customers.rows.values()])).not.toContain(PASSWORD);
    expect(logs.lines.join('')).not.toContain(PASSWORD);
    const mail = mailer.outbox.find((m) => m.to === 'kavya1@example.com')!;
    expect(mail.subject).toMatch(/Confirm your Agrismart email/);
    // Token travels in the URL fragment (never sent to servers or logs) and only its hash is stored.
    const token = mail.text.match(/\/verify-email#token=([A-Za-z0-9_-]{43})/)![1]!;
    expect(JSON.stringify(repos.customerTokens.rows)).not.toContain(token);
  });

  it('handles duplicate emails without revealing that the account exists', async () => {
    const { post, repos, mailer } = setup();
    const first = await post('/auth/register', person());
    const dup = await post('/auth/register', { ...person(), email: 'KAVYA1@example.com', name: 'Someone Else' });
    expect(dup.status).toBe(first.status);
    expect(dup.body).toEqual(first.body);
    expect(repos.customers.rows.size).toBe(1);
    expect((await repos.customers.findByEmail('kavya1@example.com'))!.name).toBe('Kavya Rao'); // unchanged
    // The real owner is told someone tried; no new verification link is issued for the duplicate.
    expect(mailer.outbox.map((m) => m.subject)).toEqual(['Confirm your Agrismart email address', 'Your Agrismart account']);
    expect(mailer.outbox[1]!.text).not.toMatch(/#token=/);
  });

  it('validates fields and password strength on the backend', async () => {
    const { post, repos } = setup((c) => {
      c.rateLimits.register = { windowMs: 60_000, limit: 100 };
    });
    const cases: [Record<string, unknown>, string][] = [
      [{ ...person(), password: 'short1A', confirmPassword: 'short1A' }, 'password'],
      [{ ...person(), password: 'alllowercase123', confirmPassword: 'alllowercase123' }, 'password'],
      [{ ...person(), password: 'Password1234', confirmPassword: 'Password1234' }, 'password'], // common
      [{ ...person(), password: 'Kavya1-Fields-99', confirmPassword: 'Kavya1-Fields-99' }, 'password'], // contains email/name
      [{ ...person(), confirmPassword: 'Different-Pass-1' }, 'confirmPassword'],
      [{ ...person(), email: 'not-an-email' }, 'email'],
      [{ ...person(), phone: '123' }, 'phone'],
      [{ ...person(), name: '<script>' }, 'name'],
    ];
    for (const [body, field] of cases) {
      const res = await post('/auth/register', body);
      expect(res.status).toBe(400);
      expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(field);
      expect(JSON.stringify(res.body)).not.toContain(String(body.password));
    }
    expect(repos.customers.rows.size).toBe(0);
  });

  it('does not let a customer assign themselves a role or verified status', async () => {
    const { post, repos } = setup();
    for (const extra of [{ role: 'admin' }, { emailVerified: true }, { isAdmin: true }]) {
      expect((await post('/auth/register', { ...person(), ...extra })).status).toBe(400);
    }
    expect(repos.customers.rows.size).toBe(0);
    expect(repos.users.rows.size).toBe(0); // staff accounts are never created from the storefront
  });
});

describe('sign in', () => {
  it('signs in and exposes the session (customer + CSRF token) without sensitive fields', async () => {
    const { signedIn } = setup();
    const { agent, csrf, res } = await signedIn();
    expect(res.body.customer).toEqual({
      email: 'kavya1@example.com',
      name: 'Kavya Rao',
      phone: '+919876543211',
      emailVerified: true,
      createdAt: expect.any(String),
    });
    const session = await agent.get('/api/customer/auth/session');
    expect(session.body.csrfToken).toBe(csrf);
    expect(JSON.stringify(session.body)).not.toMatch(/passwordHash|failedLogin|lockedUntil|"id"/);
  });

  it('returns the same generic error for unknown email and wrong password', async () => {
    const { post, signedIn } = setup();
    await signedIn();
    const wrong = await post('/auth/login', { email: 'kavya1@example.com', password: 'Wrong-Password-1' });
    const unknown = await post('/auth/login', { email: 'nobody@example.com', password: 'Wrong-Password-1' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    expect(wrong.body.error.code).toBe('invalid_credentials');
    expect(sessionCookie(wrong)).toBe('');
  });

  it('locks the account after repeated failures (still a generic error)', async () => {
    const { post, signedIn } = setup();
    await signedIn();
    for (let i = 0; i < 5; i++) await post('/auth/login', { email: 'kavya1@example.com', password: `Wrong-Pass-${i}x` });
    const res = await post('/auth/login', { email: 'kavya1@example.com', password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_credentials');
  });

  it('rate limits sign-in attempts per IP with 429', async () => {
    const { post } = setup((c) => {
      c.rateLimits.customerLogin = { windowMs: 60_000, limit: 3 };
    });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await post('/auth/login', { email: `a${i}@example.com`, password: 'x' })).status);
    expect(statuses).toEqual([401, 401, 401, 429]);
  });

  it('rate limits registration and password-reset requests', async () => {
    const { post } = setup((c) => {
      c.rateLimits.register = { windowMs: 60_000, limit: 1 };
      c.rateLimits.passwordReset = { windowMs: 60_000, limit: 2 };
    });
    expect((await post('/auth/register', person(1))).status).toBe(202);
    expect((await post('/auth/register', person(2))).status).toBe(429);
    const forgot = [];
    for (let i = 0; i < 3; i++) forgot.push((await post('/auth/forgot-password', { email: 'kavya1@example.com' })).status);
    expect(forgot).toEqual([202, 202, 429]);
  });

  it('issues a new session id on every sign-in (no session fixation) and sets secure cookie flags', async () => {
    const { signedIn, post } = setup();
    const { agent, res } = await signedIn();
    const first = sessionCookie(res);
    expect(first).toMatch(/HttpOnly/i);
    expect(first).toMatch(/SameSite=Strict/i);
    expect(first).toMatch(/Path=\//);
    expect(first).toMatch(/Max-Age=\d+/);
    const second = await post('/auth/login', { email: 'kavya1@example.com', password: PASSWORD }, agent)
      .set('X-CSRF-Token', res.body.csrfToken);
    expect(sessionCookie(second).split(';')[0]).not.toBe(first.split(';')[0]);
  });

  it('marks the cookie Secure with the __Host- prefix in production settings', async () => {
    const { signedIn } = setup((c) => {
      c.session.secureCookie = true;
      c.session.customer.cookieName = '__Host-agrismart_customer';
    });
    const { res } = await signedIn();
    const cookie = sessionCookie(res, '__Host-agrismart_customer');
    expect(cookie).toMatch(/; Secure/i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).not.toMatch(/Domain=/i);
  });
});

describe('sessions', () => {
  it('logout invalidates the server-side session (cookie replay fails)', async () => {
    const { signedIn, app } = setup();
    const { agent, csrf, res } = await signedIn();
    const stolen = sessionCookie(res).split(';')[0]!;
    expect((await agent.post('/api/customer/auth/logout').set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', csrf)).status).toBe(204);
    expect((await agent.get('/api/customer/account')).status).toBe(401);
    expect((await request(app).get('/api/customer/account').set('Cookie', stolen)).status).toBe(401);
  });

  it('expires sessions at their absolute expiry', async () => {
    const { signedIn, repos } = setup();
    const { agent } = await signedIn();
    for (const s of repos.sessions.rows.values()) s.expiresAt = new Date(Date.now() - 1000);
    expect((await agent.get('/api/customer/account')).status).toBe(401);
  });

  it('expires idle sessions', async () => {
    const { signedIn, repos, config } = setup();
    const { agent } = await signedIn();
    for (const s of repos.sessions.rows.values()) s.lastSeenAt = new Date(Date.now() - config.session.customer.idleMs - 1000);
    expect((await agent.get('/api/customer/account')).status).toBe(401);
    expect(repos.sessions.rows.size).toBe(0); // idle session deleted
  });

  it('rejects forged or malformed session cookies', async () => {
    const { app } = setup();
    for (const value of ['A'.repeat(43), 'x', '%00', 'A'.repeat(500)]) {
      expect((await request(app).get('/api/customer/account').set('Cookie', `agrismart_customer=${value}`)).status).toBe(401);
    }
  });
});

describe('CSRF protection', () => {
  it('requires the session-bound CSRF token for state-changing requests', async () => {
    const { signedIn } = setup();
    const { agent, csrf } = await signedIn();
    const other = await signedIn(2);
    const patch = (token?: string) => {
      const r = agent.patch('/api/customer/account').set('Origin', ALLOWED_ORIGIN);
      return (token ? r.set('X-CSRF-Token', token) : r).send({ name: 'Kavya R' });
    };
    expect((await patch()).status).toBe(403);
    expect((await patch('A'.repeat(43))).status).toBe(403);
    expect((await patch(other.csrf)).status).toBe(403); // another session's token is useless
    expect((await patch()).body.error.code).toBe('csrf_failed');
    expect((await patch(csrf)).status).toBe(200);
    // Cross-site requests are refused before CSRF checks: foreign Origin, or no Origin at all.
    expect((await agent.patch('/api/customer/account').set('Origin', EVIL_ORIGIN).set('X-CSRF-Token', csrf).send({ name: 'X Y' })).status).toBe(403);
    expect((await agent.patch('/api/customer/account').set('X-CSRF-Token', csrf).send({ name: 'X Y' })).status).toBe(403);

  });

  it('protects logout and checkout-with-session from CSRF', async () => {
    const { signedIn } = setup();
    const { agent, csrf } = await signedIn();
    expect((await agent.post('/api/customer/auth/logout').set('Origin', ALLOWED_ORIGIN)).status).toBe(403);
    expect((await agent.post('/api/orders').set('Origin', ALLOWED_ORIGIN).send(order())).status).toBe(403);
    expect((await agent.post('/api/orders').set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', csrf).send(order())).status).toBe(201);
  });
});

describe('protected endpoints and authorization', () => {
  it('rejects unauthenticated access to account and order history', async () => {
    const { app } = setup();
    const req = request(app);
    expect((await req.get('/api/customer/account')).status).toBe(401);
    expect((await req.get('/api/customer/orders')).status).toBe(401);
    expect((await req.get('/api/customer/orders/AGS-ABCDEFGHJK')).status).toBe(401);
    expect((await req.patch('/api/customer/account').set('Origin', ALLOWED_ORIGIN).send({ name: 'X Y' })).status).toBe(401);
    expect((await req.post('/api/customer/account/password').set('Origin', ALLOWED_ORIGIN).send({})).status).toBe(401);
    expect((await req.post('/api/customer/auth/resend-verification').set('Origin', ALLOWED_ORIGIN)).status).toBe(401);
    const session = await req.get('/api/customer/auth/session');
    expect(session.body).toEqual({ customer: null, csrfToken: null });
  });

  it('shows customers only their own orders (no IDOR)', async () => {
    const { signedIn, app } = setup();
    const a = await signedIn(1);
    const b = await signedIn(2);
    const placed = await a.agent.post('/api/orders').set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', a.csrf).send(order());
    const ref = placed.body.order.reference as string;
    const bOrder = await b.agent.post('/api/orders').set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', b.csrf).send(order());
    // Guest checkout no longer exists.
    expect((await request(app).post('/api/orders').set('Origin', ALLOWED_ORIGIN).send(order())).status).toBe(401);

    const mine = await a.agent.get('/api/customer/orders');
    expect(mine.body.items.map((o: { reference: string }) => o.reference)).toEqual([ref]);
    expect((await a.agent.get(`/api/customer/orders/${ref}`)).status).toBe(200);
    expect((await a.agent.get(`/api/customer/orders/${bOrder.body.order.reference}`)).status).toBe(404);

    expect((await b.agent.get('/api/customer/orders')).body.items.map((o: { reference: string }) => o.reference)).toEqual([
      bOrder.body.order.reference,
    ]);
    const theft = await b.agent.get(`/api/customer/orders/${ref}`);
    expect(theft.status).toBe(404);
    // The public order endpoint still requires that order's access token.
    // Always-different tampered token (a fixed replacement char would equal the real one 1 time in 64).
    const real = placed.body.accessToken as string;
    const tampered = real.slice(0, -1) + (real.endsWith('A') ? 'B' : 'A');
    expect(tampered).not.toBe(real);
    expect((await b.agent.get(`/api/orders/${ref}`).set('X-Order-Token', tampered)).status).toBe(404);
  });

  it('has no way to address another customer profile (account routes use the session only)', async () => {
    const { signedIn } = setup();
    const a = await signedIn(1);
    await signedIn(2);
    const res = await a.agent.get('/api/customer/account');
    expect(res.body.customer.email).toBe('kavya1@example.com');
    expect((await a.agent.get('/api/customer/account/kavya2@example.com')).status).toBe(404);
    // Profile updates cannot touch email, verification state or anything else.
    for (const body of [{ email: 'kavya2@example.com' }, { emailVerified: false }, { role: 'admin' }, { id: 'x' }]) {
      expect((await a.agent.patch('/api/customer/account').set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', a.csrf).send(body)).status).toBe(400);
    }
  });

  it('denies customers access to administrator APIs', async () => {
    const { signedIn, app, repos } = setup();
    await repos.users.create({ email: 'admin@example.com', passwordHash: await hashPassword('Correct-Horse-42'), role: 'admin' });
    const { agent, csrf, res } = await signedIn();
    for (const path of ['/api/admin/orders', '/api/admin/inquiries', '/api/auth/me']) {
      expect((await agent.get(path)).status).toBe(401);
    }
    expect((await agent.post('/api/admin/catalog/refresh').set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', csrf)).status).toBe(401);
    // Replaying a customer session token under the staff cookie name does not work either.
    const token = sessionCookie(res).split(';')[0]!.split('=')[1]!;
    expect((await request(app).get('/api/admin/orders').set('Cookie', `agrismart_session=${token}`)).status).toBe(401);
    // And customer credentials are not valid for staff sign-in.
    expect((await request(app).post('/api/auth/login').set('Origin', ALLOWED_ORIGIN).send({ email: 'kavya1@example.com', password: PASSWORD })).status).toBe(401);
  });
});

describe('email verification', () => {
  it('requires a verified email for order history; links are single-use; resend invalidates old links', async () => {
    const { signedIn, post, lastToken } = setup();
    const { agent, csrf } = await signedIn(1, { verify: false });
    const firstLink = lastToken('kavya1@example.com', /Confirm your Agrismart/);
    const blocked = await agent.get('/api/customer/orders');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('email_unverified');

    expect((await agent.post('/api/customer/auth/resend-verification').set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', csrf)).status).toBe(202);
    const secondLink = lastToken('kavya1@example.com', /Confirm your Agrismart/);
    expect(secondLink).not.toBe(firstLink);
    expect((await post('/auth/verify-email', { token: firstLink })).status).toBe(400); // superseded
    expect((await post('/auth/verify-email', { token: secondLink })).status).toBe(200);
    expect((await post('/auth/verify-email', { token: secondLink })).status).toBe(400); // reused
    expect((await agent.get('/api/customer/orders')).status).toBe(200);
  });

  it('rejects invalid and expired verification tokens', async () => {
    const { post, repos, lastToken } = setup();
    await post('/auth/register', person());
    expect((await post('/auth/verify-email', { token: 'A'.repeat(43) })).status).toBe(400);
    expect((await post('/auth/verify-email', { token: '../../etc' })).status).toBe(400);
    for (const t of repos.customerTokens.rows) t.expiresAt = new Date(Date.now() - 1000);
    const res = await post('/auth/verify-email', { token: lastToken('kavya1@example.com', /Confirm/) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_token');
  });
});

describe('password reset', () => {
  it('responds identically for known and unknown emails and only emails real accounts', async () => {
    const { post, signedIn, mailer } = setup();
    await signedIn();
    const before = mailer.outbox.length;
    const known = await post('/auth/forgot-password', { email: 'kavya1@example.com' });
    const unknown = await post('/auth/forgot-password', { email: 'ghost@example.com' });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
    expect(mailer.outbox.slice(before).map((m) => m.to)).toEqual(['kavya1@example.com']);
  });

  it('resets with a valid token, revokes all sessions, and rejects reuse', async () => {
    const { post, signedIn, lastToken } = setup();
    const { agent } = await signedIn();
    await post('/auth/forgot-password', { email: 'kavya1@example.com' });
    const token = lastToken('kavya1@example.com', /Reset your/);
    const NEW = 'Harvest-Moon-77';
    // A weak password is rejected without burning the link.
    expect((await post('/auth/reset-password', { token, password: 'weak', confirmPassword: 'weak' })).status).toBe(400);
    const ok = await post('/auth/reset-password', { token, password: NEW, confirmPassword: NEW });
    expect(ok.status).toBe(200);
    expect((await agent.get('/api/customer/account')).status).toBe(401); // existing session revoked
    expect((await post('/auth/reset-password', { token, password: 'Another-Pass-99', confirmPassword: 'Another-Pass-99' })).status).toBe(400); // reuse
    expect((await post('/auth/login', { email: 'kavya1@example.com', password: PASSWORD })).status).toBe(401);
    expect((await post('/auth/login', { email: 'kavya1@example.com', password: NEW })).status).toBe(200);
  });

  it('rejects expired and invalid reset tokens, and only the newest link works', async () => {
    const { post, signedIn, lastToken, repos } = setup();
    await signedIn();
    await post('/auth/forgot-password', { email: 'kavya1@example.com' });
    const older = lastToken('kavya1@example.com', /Reset your/);
    await post('/auth/forgot-password', { email: 'kavya1@example.com' });
    const newer = lastToken('kavya1@example.com', /Reset your/);
    const body = (token: string) => ({ token, password: 'Harvest-Moon-77', confirmPassword: 'Harvest-Moon-77' });
    expect((await post('/auth/reset-password', body(older))).status).toBe(400);
    expect((await post('/auth/reset-password', body('B'.repeat(43)))).status).toBe(400);
    for (const t of repos.customerTokens.rows) if (t.purpose === 'reset_password') t.expiresAt = new Date(Date.now() - 1);
    const expired = await post('/auth/reset-password', body(newer));
    expect(expired.status).toBe(400);
    expect(expired.body.error.message).toMatch(/invalid or has expired/);
  });

  it('caps reset emails per account per hour without revealing it', async () => {
    const { post, signedIn, mailer } = setup((c) => {
      c.rateLimits.passwordReset = { windowMs: 60_000, limit: 100 };
    });
    await signedIn();
    const before = mailer.outbox.length;
    for (let i = 0; i < 5; i++) expect((await post('/auth/forgot-password', { email: 'kavya1@example.com' })).status).toBe(202);
    expect(mailer.outbox.length - before).toBe(3);
  });
});

describe('account changes', () => {
  it('updates permitted profile fields with validation', async () => {
    const { signedIn } = setup();
    const { agent, csrf } = await signedIn();
    const patch = (body: object) => agent.patch('/api/customer/account').set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', csrf).send(body);
    const ok = await patch({ name: 'Kavya S Rao', phone: '+91 91234 56789' });
    expect(ok.status).toBe(200);
    expect(ok.body.customer).toMatchObject({ name: 'Kavya S Rao', phone: '+919123456789' });
    expect((await patch({ name: '<img src=x>' })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
  });

  it('requires the current password to change password and signs out other devices', async () => {
    const { signedIn, post, app } = setup();
    const { agent, csrf } = await signedIn();
    const other = request.agent(app);
    await post('/auth/login', { email: 'kavya1@example.com', password: PASSWORD }, other);
    const change = (current: string, next = 'Harvest-Moon-77') =>
      agent
        .post('/api/customer/account/password')
        .set('Origin', ALLOWED_ORIGIN)
        .set('X-CSRF-Token', csrf)
        .send({ currentPassword: current, newPassword: next, confirmPassword: next });
    const wrong = await change('Not-My-Password-1');
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('reauth_failed');
    expect((await change(PASSWORD)).status).toBe(200);
    expect((await agent.get('/api/customer/account')).status).toBe(200); // this device stays signed in
    expect((await other.get('/api/customer/account')).status).toBe(401); // other device signed out
  });

  it('changes email only after reauthentication and confirming the new address', async () => {
    const { signedIn, post, lastToken, mailer } = setup();
    const { agent, csrf } = await signedIn();
    await signedIn(2);
    const request_ = (body: object) => agent.post('/api/customer/account/email').set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', csrf).send(body);
    expect((await request_({ currentPassword: 'wrong-Password-1', newEmail: 'new@example.com' })).status).toBe(403);
    expect((await request_({ currentPassword: PASSWORD, newEmail: 'new@example.com' })).status).toBe(202);
    expect((await agent.get('/api/customer/account')).body.customer.email).toBe('kavya1@example.com'); // not yet changed
    expect((await post('/auth/verify-email', { token: lastToken('new@example.com', /new Agrismart email/) })).status).toBe(200);
    expect((await agent.get('/api/customer/account')).body.customer.email).toBe('new@example.com');
    expect(mailer.outbox.some((m) => m.to === 'kavya1@example.com' && /was changed/.test(m.subject))).toBe(true);

    // Taking another customer's address is refused at confirmation time.
    await request_({ currentPassword: PASSWORD, newEmail: 'kavya2@example.com' });
    expect((await post('/auth/verify-email', { token: lastToken('kavya2@example.com', /new Agrismart email/) })).status).toBe(409);
  });
});

describe('address book', () => {
  const address = { label: 'Farm', line1: '1 Orchard Lane', city: 'Nashik', state: 'Maharashtra', postalCode: '422001' };

  it('adds, edits, lists and deletes the customer’s own addresses', async () => {
    const { signedIn } = setup();
    const { agent, csrf } = await signedIn();
    const write = (method: 'post' | 'patch' | 'delete', path: string, body?: object) =>
      agent[method](`/api/customer${path}`).set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', csrf).send(body);
    const created = await write('post', '/addresses', address);
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), ...address, line2: null, country: 'India' });
    const id = created.body.id as string;
    const edited = await write('patch', `/addresses/${id}`, { ...address, label: 'Home', city: 'Pune' });
    expect(edited.body).toMatchObject({ id, label: 'Home', city: 'Pune' });
    expect((await agent.get('/api/customer/addresses')).body).toMatchObject({ items: [{ id, city: 'Pune' }], max: 5 });
    expect((await write('delete', `/addresses/${id}`)).status).toBe(204);
    expect((await agent.get('/api/customer/addresses')).body.items).toEqual([]);
    expect((await write('delete', `/addresses/${id}`)).status).toBe(404);
  });

  it('validates input and caps the address book at five entries', async () => {
    const { signedIn } = setup();
    const { agent, csrf } = await signedIn();
    const add = (body: object) => agent.post('/api/customer/addresses').set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', csrf).send(body);
    expect((await add({ ...address, postalCode: '<script>' })).status).toBe(400);
    expect((await add({ ...address, id: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
    expect((await add({ ...address, country: 'Elsewhere' })).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await add({ ...address, label: `Field ${i}` })).status).toBe(201);
    const full = await add(address);
    expect(full.status).toBe(409);
    expect(full.body.error.message).toMatch(/up to 5 addresses/);
  });

  it('cannot read, edit or delete another customer’s address by id (no IDOR)', async () => {
    const { signedIn } = setup();
    const a = await signedIn(1);
    const b = await signedIn(2);
    const created = await a.agent.post('/api/customer/addresses').set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', a.csrf).send(address);
    const id = created.body.id as string;
    const asB = (method: 'patch' | 'delete') =>
      b.agent[method](`/api/customer/addresses/${id}`).set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', b.csrf).send({ ...address, city: 'Stolen' });
    expect((await asB('patch')).status).toBe(404);
    expect((await asB('delete')).status).toBe(404);
    expect((await b.agent.get('/api/customer/addresses')).body.items).toEqual([]);
    expect((await a.agent.get('/api/customer/addresses')).body.items).toMatchObject([{ id, city: 'Nashik' }]);
    expect((await b.agent.patch('/api/customer/addresses/not-a-uuid').set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', b.csrf).send(address)).status).toBe(400);
  });

  it('requires sign-in, a confirmed email, the Origin header and the CSRF token', async () => {
    const { signedIn, app } = setup();
    expect((await request(app).get('/api/customer/addresses')).status).toBe(401);
    expect((await request(app).post('/api/customer/addresses').set('Origin', ALLOWED_ORIGIN).send(address)).status).toBe(401);
    const unverified = await signedIn(1, { verify: false });
    const blocked = await unverified.agent.get('/api/customer/addresses');
    expect(blocked.body.error.code).toBe('email_unverified');
    const { agent, csrf } = await signedIn(2);
    expect((await agent.post('/api/customer/addresses').set('Origin', ALLOWED_ORIGIN).send(address)).body.error.code).toBe('csrf_failed');
    expect((await agent.post('/api/customer/addresses').set('X-CSRF-Token', csrf).send(address)).status).toBe(403);
    expect((await agent.post('/api/customer/addresses').set('Origin', EVIL_ORIGIN).set('X-CSRF-Token', csrf).send(address)).status).toBe(403);
  });
});

describe('own inquiries and quotation requests', () => {
  const inquiry = { name: 'Kavya Rao', productInterest: 'FERT-010', message: 'Please quote for 20 bags of compost.' };

  it('lists only the customer’s own inquiries; other references return 404 (no IDOR)', async () => {
    const { signedIn } = setup();
    const a = await signedIn(1);
    const b = await signedIn(2);
    const send = (s: typeof a, body: object) => s.agent.post('/api/inquiries').set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', s.csrf).send(body);
    const quote = await send(a, { ...inquiry, kind: 'quotation', quantity: 20 });
    expect(quote.status).toBe(202);
    const bRef = (await send(b, { ...inquiry, message: 'Do you deliver to Satara district?' })).body.reference as string;

    const mine = await a.agent.get('/api/customer/inquiries');
    expect(mine.body.total).toBe(1);
    expect(mine.body.items[0]).toEqual({
      reference: quote.body.reference,
      kind: 'quotation',
      productInterest: 'FERT-010',
      quantity: 20,
      message: inquiry.message,
      status: 'forwarded',
      createdAt: expect.any(String),
    });
    // No CRM internals, emails or sync state in the customer view.
    expect(JSON.stringify(mine.body)).not.toMatch(/CRM-LEAD|dedupe|kavya1@example.com|attempts/);
    expect((await a.agent.get(`/api/customer/inquiries/${quote.body.reference}`)).status).toBe(200);
    expect((await a.agent.get(`/api/customer/inquiries/${bRef}`)).status).toBe(404);
    expect((await b.agent.get(`/api/customer/inquiries/${quote.body.reference}`)).status).toBe(404);
    expect((await b.agent.get('/api/customer/inquiries')).body.items.map((i: { reference: string }) => i.reference)).toEqual([bRef]);
  });

  it('requires a signed-in customer with a confirmed email', async () => {
    const { signedIn, app } = setup();
    expect((await request(app).get('/api/customer/inquiries')).status).toBe(401);
    expect((await request(app).get('/api/customer/inquiries/INQ-ABCDEFGHJK')).status).toBe(401);
    const unverified = await signedIn(1, { verify: false });
    expect((await unverified.agent.get('/api/customer/inquiries')).status).toBe(403);
  });

  it('protects inquiry submission from CSRF and cross-site requests', async () => {
    const { signedIn, repos } = setup();
    const { agent, csrf } = await signedIn();
    expect((await agent.post('/api/inquiries').set('Origin', ALLOWED_ORIGIN).send(inquiry)).body.error.code).toBe('csrf_failed');
    expect((await agent.post('/api/inquiries').set('X-CSRF-Token', csrf).send(inquiry)).status).toBe(403); // no Origin
    expect((await agent.post('/api/inquiries').set('Origin', EVIL_ORIGIN).set('X-CSRF-Token', csrf).send(inquiry)).status).toBe(403);
    expect(repos.inquiries.rows.size).toBe(0);
  });
});

describe('profile changes need a confirmed email', () => {
  it('blocks name/phone changes until verified, but still allows securing the account', async () => {
    const { signedIn } = setup();
    const { agent, csrf } = await signedIn(1, { verify: false });
    const blocked = await agent.patch('/api/customer/account').set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', csrf).send({ name: 'Kavya S Rao' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('email_unverified');
    // Changing the password (or correcting a mistyped email) is still possible.
    const pw = await agent
      .post('/api/customer/account/password')
      .set('Origin', ALLOWED_ORIGIN)
      .set('X-CSRF-Token', csrf)
      .send({ currentPassword: PASSWORD, newPassword: 'Harvest-Moon-2027', confirmPassword: 'Harvest-Moon-2027' });
    expect(pw.status).toBe(200);
  });
});
