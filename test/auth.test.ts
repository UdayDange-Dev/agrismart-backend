import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/services/authService.js';
import { ALLOWED_ORIGIN, buildTestApp, customerSession, EVIL_ORIGIN, startStubErp, type StubErp } from './helpers.js';

let erp: StubErp;
let adminHash: string;
let staffHash: string;
const ADMIN = { email: 'admin@example.com', password: 'Correct-Horse-42' };
const STAFF = { email: 'staff@example.com', password: 'Staff-Password-77' };

beforeAll(async () => {
  erp = await startStubErp();
  [adminHash, staffHash] = await Promise.all([hashPassword(ADMIN.password), hashPassword(STAFF.password)]);
});
afterAll(() => erp.close());

async function setup() {
  const ctx = buildTestApp(erp.url);
  await ctx.repos.users.create({ email: ADMIN.email, passwordHash: adminHash, role: 'admin' });
  await ctx.repos.users.create({ email: STAFF.email, passwordHash: staffHash, role: 'staff' });
  const login = async (creds: { email: string; password: string }) => {
    const agent = request.agent(ctx.app);
    const res = await agent.post('/api/auth/login').set('Origin', ALLOWED_ORIGIN).send(creds);
    return { agent, res, csrf: res.body.csrfToken as string };
  };
  return { ...ctx, login };
}

describe('authentication', () => {
  it('logs in with an HttpOnly, SameSite=Strict session cookie and never returns the hash', async () => {
    const { login } = await setup();
    const { res } = await login(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: { email: ADMIN.email, role: 'admin' }, csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
  });

  it('uses the same generic error for unknown users and wrong passwords', async () => {
    const { login } = await setup();
    const unknown = await login({ email: 'nobody@example.com', password: 'whatever-123' });
    const wrong = await login({ email: ADMIN.email, password: 'wrong-password' });
    expect(unknown.res.status).toBe(401);
    expect(wrong.res.status).toBe(401);
    expect(unknown.res.body.error.message).toBe(wrong.res.body.error.message);
  });

  it('locks the account after repeated failures, even for the right password', async () => {
    const { login } = await setup();
    for (let i = 0; i < 5; i++) await login({ email: STAFF.email, password: `bad-${i}` });
    const { res } = await login(STAFF);
    expect(res.status).toBe(401);
  });

  it('rate limits login attempts per IP', async () => {
    const ctx = buildTestApp(erp.url, {
      configure: (c) => {
        c.rateLimits.login = { windowMs: 60_000, limit: 2 };
      },
    });
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await request(ctx.app).post('/api/auth/login').set('Origin', ALLOWED_ORIGIN).send({ email: 'a@example.com', password: 'x' })).status);
    }
    expect(statuses[2]).toBe(429);
  });

  it('requires an allowlisted Origin for cookie-authenticated writes (CSRF)', async () => {
    const { app } = await setup();
    expect((await request(app).post('/api/auth/login').send(ADMIN)).status).toBe(403);
    expect((await request(app).post('/api/auth/login').set('Origin', EVIL_ORIGIN).send(ADMIN)).status).toBe(403);
  });

  it('invalidates the session on logout', async () => {
    const { login } = await setup();
    const { agent, csrf } = await login(ADMIN);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    // Logout is state-changing: without the CSRF token it is refused (no forced-logout CSRF).
    expect((await agent.post('/api/auth/logout').set('Origin', ALLOWED_ORIGIN)).status).toBe(403);
    expect((await agent.post('/api/auth/logout').set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', csrf)).status).toBe(204);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('rejects forged or malformed session cookies', async () => {
    const { app } = await setup();
    const res = await request(app).get('/api/auth/me').set('Cookie', 'agrismart_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(res.status).toBe(401);
  });
});

describe('role-based authorization', () => {
  it('denies anonymous access to admin endpoints', async () => {
    const { app } = await setup();
    expect((await request(app).get('/api/admin/inquiries')).status).toBe(401);
    expect((await request(app).get('/api/admin/orders')).status).toBe(401);
  });

  it('allows staff to read but not to modify (vertical privilege escalation)', async () => {
    const { login } = await setup();
    const { agent, csrf } = await login(STAFF);
    expect((await agent.get('/api/admin/inquiries')).status).toBe(200);
    // Valid Origin and CSRF token, so the 403 comes from the role check itself.
    const refresh = await agent.post('/api/admin/catalog/refresh').set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', csrf);
    expect(refresh.status).toBe(403);
    expect(refresh.body.error.code).toBe('forbidden');
    const patch = await agent
      .patch('/api/admin/orders/AGS-AAAAAAAAAA/status')
      .set('Origin', ALLOWED_ORIGIN)
      .set('X-CSRF-Token', csrf)
      .send({ status: 'confirmed' });
    expect(patch.status).toBe(403);
    expect(patch.body.error.code).toBe('forbidden');
  });

  it('lets admins change order status through allowed transitions only', async () => {
    const { app, login, repos } = await setup();
    const buyer = await customerSession(app, repos);
    const created = await buyer.post('/api/orders', {
        customer: { name: 'Asha Patil', phone: '9876543210' },
        shippingAddress: { line1: '12 Farm Road', city: 'Pune', state: 'Maharashtra', postalCode: '411001' },
        items: [{ itemCode: 'SEED-001', qty: 1 }],
        acceptTerms: true,
      });
    const ref = created.body.order.reference;
    const { agent, csrf } = await login(ADMIN);
    const patch = (status: string) =>
      agent.patch(`/api/admin/orders/${ref}/status`).set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', csrf).send({ status });
    expect((await patch('fulfilled')).status).toBe(409); // cannot skip confirmation
    expect((await patch('confirmed')).status).toBe(200);
    expect((await patch('fulfilled')).status).toBe(200);
    expect((await patch('pending_review')).status).toBe(400); // not a settable status
    const list = await agent.get('/api/admin/orders');
    expect(list.body.items[0]).not.toHaveProperty('accessTokenHash');
  });

  it('rejects admin writes without Origin or a valid CSRF token even with a valid session cookie', async () => {
    const { login } = await setup();
    const { agent, csrf } = await login(ADMIN);
    expect((await agent.post('/api/admin/catalog/refresh').set('X-CSRF-Token', csrf)).status).toBe(403); // no Origin
    expect((await agent.post('/api/admin/catalog/refresh').set('Origin', ALLOWED_ORIGIN)).status).toBe(403); // no CSRF token
    expect((await agent.post('/api/admin/catalog/refresh').set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', 'x'.repeat(43))).status).toBe(403);
    expect((await agent.post('/api/admin/catalog/refresh').set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', csrf)).status).toBe(200);
  });

  it('applies role changes and account disabling immediately', async () => {
    const { login, repos } = await setup();
    const { agent } = await login(ADMIN);
    const user = await repos.users.findByEmail(ADMIN.email);
    repos.users.rows.get(user!.id)!.disabled = true;
    expect((await agent.get('/api/admin/orders')).status).toBe(401);
  });
});
