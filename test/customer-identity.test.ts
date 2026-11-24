import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeMobile } from '../src/schemas/index.js';
import { ALLOWED_ORIGIN, buildTestApp, CUSTOMER_PASSWORD, customerSession, startStubErp, type StubErp } from './helpers.js';

/** Email and mobile normalisation, duplicate prevention and the (unchanged) shared-mobile policy. */
let erp: StubErp;
beforeAll(async () => {
  erp = await startStubErp();
});
afterAll(() => erp.close());

function setup() {
  const ctx = buildTestApp(erp.url);
  const register = (email: string, phone = '+91 98765 43210') =>
    request(ctx.app)
      .post('/api/customer/auth/register')
      .set('Origin', ALLOWED_ORIGIN)
      .send({ name: 'Kavya Rao', email, phone, password: CUSTOMER_PASSWORD, confirmPassword: CUSTOMER_PASSWORD });
  return { ...ctx, register };
}

describe('email', () => {
  it('is trimmed and lower-cased before lookup and storage; duplicates get the same generic answer', async () => {
    const { register, repos, mailer } = setup();
    const first = await register('  Farmer@Example.COM ');
    expect(first.status).toBe(202);
    expect([...repos.customers.rows.values()].map((c) => c.email)).toEqual(['farmer@example.com']);
    const again = await register('farmer@EXAMPLE.com');
    expect(again.status).toBe(202);
    expect(again.body).toEqual(first.body); // no hint that the address exists
    expect(repos.customers.rows.size).toBe(1);
    expect(mailer.outbox.at(-1)).toMatchObject({ to: 'farmer@example.com', subject: 'Your Agrismart account' }); // the owner is told instead
  });

  it('concurrent registrations of the same address create exactly one account', async () => {
    const { register, repos } = setup();
    const results = await Promise.all(['dup@example.com', 'DUP@example.com', ' dup@example.com', 'Dup@Example.com'].map((e) => register(e)));
    expect(results.every((r) => r.status === 202)).toBe(true);
    expect(repos.customers.rows.size).toBe(1);
  });

  it('cannot be changed to an address another customer owns; the error reveals no internals', async () => {
    const { app, repos, mailer, register } = setup();
    await register('owner@example.com');
    const s = await customerSession(app, repos, { email: 'mover@example.com' });
    expect((await s.post('/api/customer/account/email', { currentPassword: CUSTOMER_PASSWORD, newEmail: ' OWNER@example.com ' })).status).toBe(202);
    const token = mailer.outbox.filter((m) => m.to === 'owner@example.com').at(-1)!.text.match(/#token=([A-Za-z0-9_-]{43})/)![1]!;
    const confirm = await request(app).post('/api/customer/auth/verify-email').set('Origin', ALLOWED_ORIGIN).send({ token });
    expect(confirm.status).toBe(409);
    expect(JSON.stringify(confirm.body)).not.toMatch(/E11000|duplicate key|index|Mongo/i);
    expect((await repos.customers.findById(s.id))!.email).toBe('mover@example.com');
  });
});

describe('mobile number', () => {
  it('normalises valid numbers to E.164 with India as the default region', () => {
    expect(normalizeMobile('9876543210')).toBe('+919876543210');
    expect(normalizeMobile(' +91 98765-43210 ')).toBe('+919876543210');
    expect(normalizeMobile('098765 43210')).toBe('+919876543210');
    expect(normalizeMobile('+1 202 555 0143')).toBe('+12025550143');
    for (const bad of ['', '   ', '12345', '0000000000', '+91 12345', 'call me', '+9198765432101234']) expect(normalizeMobile(bad)).toBeNull();
  });

  it('is validated and stored normalised on registration and profile updates', async () => {
    const { register, repos, app } = setup();
    expect((await register('m1@example.com', '98765 43210')).status).toBe(202);
    expect((await repos.customers.findByEmail('m1@example.com'))!.phone).toBe('+919876543210');
    const bad = await register('m2@example.com', '12345 67');
    expect(bad.status).toBe(400);
    expect(bad.body.error.details).toContainEqual({ path: 'phone', message: 'Enter a valid mobile number' });
    expect((await register('m3@example.com', '')).status).toBe(400); // required on accounts

    const s = await customerSession(app, repos);
    expect((await s.patch('/api/customer/account', { phone: '0000000000' })).status).toBe(400);
    const ok = await s.patch('/api/customer/account', { phone: '(0) 91234 56789' });
    expect(ok.status).toBe(200);
    expect(ok.body.customer.phone).toBe('+919123456789');
  });

  it('may be shared by several accounts (no uniqueness rule is approved) and accounts are never merged', async () => {
    const { register, repos } = setup();
    expect((await register('family1@example.com', '+91 98765 43210')).status).toBe(202);
    expect((await register('family2@example.com', '9876543210')).status).toBe(202);
    const phones = [...repos.customers.rows.values()].map((c) => [c.email, c.phone]);
    expect(phones).toEqual([
      ['family1@example.com', '+919876543210'],
      ['family2@example.com', '+919876543210'],
    ]);
  });
});
