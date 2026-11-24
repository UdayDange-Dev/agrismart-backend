import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { hashPassword } from '../src/lib/password.js';
import { ORIGIN_SECRET_HEADER } from '../src/middleware/originGate.js';
import { ALLOWED_ORIGIN, buildTestApp, CUSTOMER_PASSWORD, EVIL_ORIGIN, startStubErp, testEnv, type StubErp } from './helpers.js';

/**
 * Origin gate (Render behind Vercel): the API must answer only requests that came through the
 * frontend proxy, which adds the shared secret header; direct requests are refused, and the
 * visitor IP used for rate limits cannot be forged by a client.
 */

const SECRET = 'gate-secret-0123456789-abcdefghijklmnopqrstuvwxyz';

let erp: StubErp;
beforeAll(async () => {
  erp = await startStubErp();
});
afterAll(() => erp.close());

const gatedApp = (extra: Record<string, string> = {}) => buildTestApp(erp.url, { env: { ORIGIN_SHARED_SECRET: SECRET, ...extra } });

describe('origin gate', () => {
  it('refuses direct requests without the secret, before any route runs', async () => {
    const { app, repos } = gatedApp();
    for (const res of [
      await request(app).get('/api/products'),
      await request(app).get('/api/customer/auth/session'),
      await request(app).get('/api/admin/orders'),
      await request(app).post('/api/customer/auth/login').set('Origin', ALLOWED_ORIGIN).send({ email: 'a@example.com', password: 'x' }),
      await request(app).post('/api/inquiries').set('Origin', ALLOWED_ORIGIN).send({}),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('forbidden');
      // Generic: says nothing about the gate, the header name or the expected value.
      expect(JSON.stringify(res.body)).not.toMatch(/secret|origin-secret|gate/i);
    }
    expect(repos.inquiries.rows.size).toBe(0);
  });

  it('refuses a wrong, empty, truncated or unexpanded secret', async () => {
    const { app } = gatedApp();
    for (const bad of ['wrong', '', SECRET.slice(0, -1), `${SECRET}x`, '$ORIGIN_SECRET', SECRET.toUpperCase()]) {
      expect((await request(app).get('/api/products').set(ORIGIN_SECRET_HEADER, bad)).status).toBe(403);
    }
  });

  it('accepts requests that carry the secret', async () => {
    const { app } = gatedApp();
    const res = await request(app).get('/api/products').set(ORIGIN_SECRET_HEADER, SECRET);
    expect(res.status).toBe(200);
  });

  it('lets the platform health probes through without the secret, and they disclose nothing', async () => {
    const { app } = gatedApp();
    const live = await request(app).get('/api/health');
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ status: 'ok' });
    const ready = await request(app).get('/api/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ready' });
    // Only GET/HEAD on the exact probe paths are exempt.
    expect((await request(app).post('/api/health').send({})).status).toBe(403);
    expect((await request(app).get('/api/health/../products')).status).toBe(403);
  });

  it('never echoes or logs the secret', async () => {
    const { app, logs } = gatedApp();
    const res = await request(app).get('/api/products').set(ORIGIN_SECRET_HEADER, SECRET);
    expect(JSON.stringify(res.headers)).not.toContain(SECRET);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    await request(app).get('/api/products').set(ORIGIN_SECRET_HEADER, 'wrong-guess');
    expect(logs.lines.join('\n')).not.toContain(SECRET);
    expect(logs.lines.join('\n')).not.toContain('wrong-guess');
  });

  it('keeps the existing session, CSRF and Origin checks behind the gate', async () => {
    const { app, repos } = gatedApp();
    const email = 'gate-customer@example.com';
    const customer = await repos.customers.create({ email, name: 'Asha Patil', phone: '+919876543210', passwordHash: await hashPassword(CUSTOMER_PASSWORD) });
    await repos.customers.markEmailVerified(customer.id, new Date());
    const agent = request.agent(app);
    const proxied = (method: 'get' | 'post', path: string) => agent[method](path).set(ORIGIN_SECRET_HEADER, SECRET);

    const login = await proxied('post', '/api/customer/auth/login').set('Origin', ALLOWED_ORIGIN).send({ email, password: CUSTOMER_PASSWORD });
    expect(login.status).toBe(200);
    const csrf = login.body.csrfToken as string;
    const inquiry = { kind: 'inquiry', name: 'Asha Patil', message: 'A question about tomato seeds.', website: '' };

    // Through the proxy, but without the CSRF token, with a foreign Origin, or with no Origin: refused.
    expect((await proxied('post', '/api/inquiries').set('Origin', ALLOWED_ORIGIN).send(inquiry)).status).toBe(403);
    expect((await proxied('post', '/api/inquiries').set('Origin', EVIL_ORIGIN).set('X-CSRF-Token', csrf).send(inquiry)).status).toBe(403);
    expect((await proxied('post', '/api/inquiries').set('X-CSRF-Token', csrf).send(inquiry)).status).toBe(403);
    // With the session cookie but WITHOUT the gate secret (direct to the origin): refused.
    expect((await agent.post('/api/inquiries').set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', csrf).send(inquiry)).status).toBe(403);
    expect(repos.inquiries.rows.size).toBe(0);
    // The real storefront request succeeds.
    expect((await proxied('post', '/api/inquiries').set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', csrf).send(inquiry)).status).toBe(202);
    expect(repos.inquiries.rows.size).toBe(1);
  });
});

describe('client IP behind the gate', () => {
  it('rate-limits by the visitor IP that the proxy reports (first X-Forwarded-For entry)', async () => {
    const { app } = gatedApp();
    const login = (ip: string) =>
      request(app)
        .post('/api/customer/auth/login')
        .set(ORIGIN_SECRET_HEADER, SECRET)
        .set('Origin', ALLOWED_ORIGIN)
        // As delivered by Vercel (visitor) and appended by Render's proxy.
        .set('X-Forwarded-For', `${ip}, 76.76.21.21`)
        .send({ email: 'nobody@example.com', password: 'Wrong-Password-1' });
    for (let i = 0; i < 10; i += 1) expect((await login('203.0.113.7')).status).not.toBe(429);
    expect((await login('203.0.113.7')).status).toBe(429);
    // A different visitor behind the same proxy hop is unaffected.
    expect((await login('198.51.100.9')).status).not.toBe(429);
  });

  it('cannot be spoofed: forged X-Forwarded-For without the secret never reaches a route', async () => {
    const { app } = gatedApp();
    for (let i = 0; i < 20; i += 1) {
      const res = await request(app)
        .post('/api/customer/auth/login')
        .set('Origin', ALLOWED_ORIGIN)
        .set('X-Forwarded-For', `10.0.0.${i}`)
        .send({ email: 'nobody@example.com', password: 'Wrong-Password-1' });
      expect(res.status).toBe(403);
    }
  });

  it('ignores a malformed first X-Forwarded-For entry (falls back to the connection address)', async () => {
    const { app } = gatedApp();
    const login = (xff: string) =>
      request(app)
        .post('/api/customer/auth/login')
        .set(ORIGIN_SECRET_HEADER, SECRET)
        .set('Origin', ALLOWED_ORIGIN)
        .set('X-Forwarded-For', xff)
        .send({ email: 'nobody@example.com', password: 'Wrong-Password-1' });
    // Rotating junk values all map to the same fallback key, so they cannot dodge the limit.
    for (let i = 0; i < 10; i += 1) expect((await login(`not-an-ip-${i}`)).status).not.toBe(429);
    expect((await login('still-not-an-ip')).status).toBe(429);
  });
});

describe('origin gate configuration', () => {
  const production = {
    ...testEnv('https://erp.example.com/'),
    NODE_ENV: 'production',
    ERPNEXT_ALLOWED_HOSTS: 'erp.example.com',
    ERPNEXT_PRICE_LIST: 'MRP',
    CORS_ALLOWED_ORIGINS: 'https://shop.example.com',
    APP_PUBLIC_URL: 'https://shop.example.com',
    SMTP_HOST: 'smtp.example.com',
    SMTP_USER: 'mailer',
    SMTP_PASS: 'smtp-password-123',
    MAIL_FROM: 'Agrismart <no-reply@shop.example.com>',
    ERPNEXT_LEAD_SYNC: 'false',
  };
  const problemsOf = (env: Record<string, string | undefined>) => {
    try {
      loadConfig(env);
      return [];
    } catch (err) {
      return (err as { problems: string[] }).problems;
    }
  };

  it('is required in production', () => {
    expect(problemsOf(production).join(' ')).toContain('ORIGIN_SHARED_SECRET is required in production');
    expect(loadConfig({ ...production, ORIGIN_SHARED_SECRET: SECRET }).originGate).toEqual({ secret: SECRET });
  });

  it('rejects short, placeholder or unexpanded secrets without printing them', () => {
    for (const bad of ['too-short', '$ORIGIN_SECRET_padding_padding_padding_padding', 'x'.repeat(300), 'has spaces in it but is long enough okay']) {
      const problems = problemsOf({ ...production, ORIGIN_SHARED_SECRET: bad });
      expect(problems.some((p) => p.startsWith('ORIGIN_SHARED_SECRET'))).toBe(true);
      expect(problems.join(' ')).not.toContain(bad);
    }
  });

  it('is optional in development and tests (no gate)', () => {
    expect(loadConfig(testEnv('http://127.0.0.1:9/')).originGate).toBeNull();
  });
});
