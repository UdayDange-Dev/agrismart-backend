import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ALLOWED_ORIGIN, buildTestApp, customerSession, EVIL_ORIGIN, startStubErp, TEST_API_KEY, TEST_API_SECRET, type StubErp } from './helpers.js';

let erp: StubErp;
beforeAll(async () => {
  erp = await startStubErp();
});
afterAll(() => erp.close());

const validInquiry = {
  name: 'Ravi Kumar',
  phone: '+91 98765 43210',
  message: 'I would like a quote for tomato seeds.',
};

describe('HTTP hardening', () => {
  it('sets security headers and hides the framework banner', async () => {
    const { app } = buildTestApp(erp.url);
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  });

  it('returns JSON 404 for unknown routes and unsupported methods', async () => {
    const { app } = buildTestApp(erp.url);
    expect((await request(app).get('/api/debug')).status).toBe(404);
    expect((await request(app).delete('/api/products')).status).toBe(404);
    expect((await request(app).get('/.env')).status).toBe(404);
  });

  it('reports readiness without leaking details', async () => {
    const { app } = buildTestApp(erp.url, { isReady: () => false });
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not_ready' });
  });
});

describe('CORS and origin checks', () => {
  it('grants CORS only to allowlisted origins', async () => {
    const { app } = buildTestApp(erp.url);
    const ok = await request(app).get('/api/health').set('Origin', ALLOWED_ORIGIN);
    expect(ok.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    const evil = await request(app).get('/api/health').set('Origin', EVIL_ORIGIN);
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects state-changing requests from unauthorised origins', async () => {
    const { app, repos } = buildTestApp(erp.url);
    const res = await request(app).post('/api/inquiries').set('Origin', EVIL_ORIGIN).send(validInquiry);
    expect(res.status).toBe(403);
    expect(repos.inquiries.rows.size).toBe(0);
  });

  it('rejects preflight from unauthorised origins (no allow headers)', async () => {
    const { app } = buildTestApp(erp.url);
    const res = await request(app)
      .options('/api/inquiries')
      .set('Origin', EVIL_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('request body limits and parsing', () => {
  it('rejects oversized bodies with 413', async () => {
    const { app } = buildTestApp(erp.url);
    const res = await request(app)
      .post('/api/inquiries')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ ...validInquiry, message: 'x'.repeat(40_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });

  it('rejects malformed JSON with a generic 400', async () => {
    const { app } = buildTestApp(erp.url);
    const res = await request(app).post('/api/inquiries').set('Content-Type', 'application/json').send('{"name": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_body');
    expect(JSON.stringify(res.body)).not.toMatch(/SyntaxError|at JSON\.parse|node_modules/);
  });
});

describe('input validation and injection', () => {
  it('rejects unexpected fields (mass assignment / prototype pollution)', async () => {
    const { app, repos } = buildTestApp(erp.url);
    const c = await customerSession(app, repos);
    const extras = [{ role: 'admin' }, { syncStatus: 'synced' }, { customerId: 'someone' }, { email: 'other@example.com' }, JSON.parse('{"__proto__": {"polluted": true}}') as object];
    for (const extra of extras) {
      const res = await c.agent
        .post('/api/inquiries')
        .set('Origin', ALLOWED_ORIGIN)
        .set('X-CSRF-Token', c.csrf)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ ...validInquiry, ...extra }));
      expect(res.status).toBe(400);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects client-supplied prices in the cart', async () => {
    const { app } = buildTestApp(erp.url);
    const res = await request(app)
      .post('/api/cart/quote')
      .send({ items: [{ itemCode: 'SEED-001', qty: 1, price: 0.01 }] });
    expect(res.status).toBe(400);
  });

  it('rejects NoSQL operator payloads', async () => {
    const { app, repos } = buildTestApp(erp.url);
    const c = await customerSession(app, repos);
    const inquiry = await c.post('/api/inquiries', { ...validInquiry, name: { $gt: '' }, productInterest: { $ne: null } });
    expect(inquiry.status).toBe(400);
    const login = await request(app)
      .post('/api/auth/login')
      .set('Origin', ALLOWED_ORIGIN)
      .send({ email: { $ne: null }, password: { $ne: null } });
    expect(login.status).toBe(400);
    const query = await request(app).get('/api/products?category[$ne]=x');
    expect(query.status).toBe(400);
  });

  it('rejects repeated query parameters instead of coercing arrays', async () => {
    const { app } = buildTestApp(erp.url);
    expect((await request(app).get('/api/products?q=a&q=b')).status).toBe(400);
  });

  it('validates realistic field formats and lengths without echoing input', async () => {
    // Invalid attempts count towards the inquiry rate limit too, so raise it for this test.
    const ctx = buildTestApp(erp.url, {
      configure: (c) => {
        c.rateLimits.inquiries = { windowMs: 60_000, limit: 100 };
      },
    });
    const { app, repos } = ctx;
    const c = await customerSession(app, repos);
    const cases = [
      { ...validInquiry, kind: 'complaint' },
      { ...validInquiry, quantity: -1 },
      { ...validInquiry, phone: '12' },
      { ...validInquiry, name: 'R' },
      { ...validInquiry, name: '<script>alert(1)</script>' },
      { ...validInquiry, message: 'short' },
      { ...validInquiry, message: 'hello\u0000world with null byte' },
      { ...validInquiry, website: 'http://spam.example' }, // honeypot
    ];
    for (const body of cases) {
      const res = await c.post('/api/inquiries', body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
      expect(JSON.stringify(res.body)).not.toContain('<script>');
    }
  });

  it('stores XSS payloads in messages as inert text and escapes them in the ERPNext comment', async () => {
    const { app, repos } = buildTestApp(erp.url);
    const c = await customerSession(app, repos, { email: 'xss@example.com' });
    const payload = 'Please call me <img src=x onerror=alert(1)> about seeds';
    const res = await c.post('/api/inquiries', { ...validInquiry, message: payload });
    expect(res.status).toBe(202);
    const comment = erp.comments.at(-1)!;
    expect(comment.content).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(comment.content).not.toContain('<img');
  });
});

describe('rate limiting', () => {
  it('returns 429 after the inquiry limit is reached', async () => {
    const { app, repos } = buildTestApp(erp.url, {
      configure: (c) => {
        c.rateLimits.inquiries = { windowMs: 60_000, limit: 2 };
      },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await customerSession(app, repos, { email: `rl${i}@example.com` });
      const res = await c.post('/api/inquiries', validInquiry);
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 2)).toEqual([202, 202]);
    expect(statuses[2]).toBe(429);
  });

  it('applies a global limit and does not trust spoofed X-Forwarded-For when trust proxy is off', async () => {
    const { app } = buildTestApp(erp.url, {
      configure: (c) => {
        c.rateLimits.global = { windowMs: 60_000, limit: 3 };
      },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await request(app).get('/api/health').set('X-Forwarded-For', `10.0.0.${i}`)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('ignores a client-supplied Forwarded header: no rate-limit warning and no limit bypass', async () => {
    const { app } = buildTestApp(erp.url, {
      configure: (c) => {
        c.rateLimits.global = { windowMs: 60_000, limit: 3 };
      },
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push((await request(app).get('/api/health').set('Forwarded', `for=10.0.0.${i};host=evil.example`)).status);
      }
      expect(statuses).toEqual([200, 200, 200, 429]); // all counted as the same (socket) client
      const logged = [...errors.mock.calls, ...warnings.mock.calls].map((args) => args.map(String).join(' ')).join('\n');
      expect(logged).not.toContain('ERR_ERL_FORWARDED_HEADER');
    } finally {
      errors.mockRestore();
      warnings.mockRestore();
    }
  });

  it('behind one trusted proxy (TRUST_PROXY=1, as with Nginx), clients are told apart by X-Forwarded-For', async () => {
    const { app } = buildTestApp(erp.url, {
      env: { TRUST_PROXY: '1' },
      configure: (c) => {
        c.rateLimits.global = { windowMs: 60_000, limit: 2 };
      },
    });
    const get = (client: string) => request(app).get('/api/health').set('X-Forwarded-For', client);
    expect([(await get('203.0.113.1')).status, (await get('203.0.113.1')).status, (await get('203.0.113.1')).status]).toEqual([200, 200, 429]);
    expect((await get('203.0.113.2')).status).toBe(200); // a different client keeps its own budget
  });
});

describe('error handling and secret leakage', () => {
  it('returns a generic 500 without stack traces or internal details', async () => {
    const { app, repos, logs } = buildTestApp(erp.url);
    const c = await customerSession(app, repos);
    repos.inquiries.findByDedupeKey = async () => {
      throw new Error('MongoServerError: connection to 10.0.0.5:27017 refused at /srv/app/node_modules/mongodb');
    };
    const res = await c.post('/api/inquiries', validInquiry);
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: 'internal_error', message: 'An unexpected error occurred', requestId: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toMatch(/Mongo|10\.0\.0\.5|node_modules|stack/);
    expect(logs.lines.join('')).toContain('Unhandled error'); // still diagnosable server-side
  });

  it('never exposes ERPNext credentials, hosts or internal image paths in responses or logs', async () => {
    const { app, logs, repos } = buildTestApp(erp.url);
    const leaker = await customerSession(app, repos, { email: 'leak@example.com' });
    const responses = [
      await request(app).get('/api/products'),
      await request(app).get('/api/products/SEED-001'),
      await leaker.post('/api/inquiries', validInquiry),
      await request(app).post('/api/cart/quote').send({ items: [{ itemCode: 'SEED-001', qty: 2 }] }),
    ];
    const all = responses.map((r) => JSON.stringify(r.body) + JSON.stringify(r.headers)).join('') + logs.lines.join('');
    for (const secret of [TEST_API_KEY, TEST_API_SECRET, '127.0.0.1:', '/files/tomato.png']) {
      expect(all).not.toContain(secret);
    }
    // Personal data from the inquiry is not written to logs.
    expect(logs.lines.join('')).not.toContain('leak@example.com');
    expect(logs.lines.join('')).not.toContain('tomato seeds');
  });

  it('returns 503 (not 500 or upstream details) when ERPNext rejects credentials', async () => {
    const { app } = buildTestApp(erp.url, { env: { ERPNEXT_API_SECRET: 'definitely-wrong-secret' } });
    const res = await request(app).get('/api/products');
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toMatch(/Traceback|PermissionError|definitely-wrong/);
  });
});
