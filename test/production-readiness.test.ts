import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/env.js';
import { ErpNextClient, ErpNextError } from '../src/integrations/erpnext/client.js';
import { hashPassword } from '../src/services/authService.js';
import { ALLOWED_ORIGIN, buildTestApp, customerSession, startStubErp, TEST_API_KEY, TEST_API_SECRET, testEnv, type StubErp } from './helpers.js';

/** Settings and safeguards for connecting to a production ERPNext site. */
let erp: StubErp;
beforeAll(async () => {
  erp = await startStubErp();
});
afterAll(() => erp.close());
beforeEach(() => {
  erp.leads.length = 0;
  erp.comments.length = 0;
  erp.requests.length = 0;
  erp.override.clear();
});

const problemsOf = (env: NodeJS.ProcessEnv): string[] => {
  try {
    loadConfig(env);
    return [];
  } catch (err) {
    return err instanceof ConfigError ? err.problems : ['not a ConfigError'];
  }
};

describe('configuration', () => {
  const production = (extra: Record<string, string | undefined>) =>
    testEnv('https://asfsl.sanvidhierp.in/', {
      NODE_ENV: 'production',
      ORIGIN_SHARED_SECRET: 'test-origin-secret-0123456789abcdefghij',
      ERPNEXT_ALLOWED_HOSTS: 'asfsl.sanvidhierp.in',
      CORS_ALLOWED_ORIGINS: 'https://shop.example.com',
      APP_PUBLIC_URL: 'https://shop.example.com',
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'mailer',
      SMTP_PASS: 'smtp-password-123',
      MAIL_FROM: 'Agrismart <no-reply@shop.example.com>',
      ERPNEXT_WRITE_APPROVED_HOST: 'asfsl.sanvidhierp.in',
      ...extra,
    } as Record<string, string>);

  it('accepts the production ERPNext site when the price list is chosen explicitly', () => {
    const config = loadConfig(production({ ERPNEXT_PRICE_LIST: 'Standard Selling' }));
    expect(config.erpnext.baseUrl.host).toBe('asfsl.sanvidhierp.in');
    expect(config.erpnext.priceList).toBe('Standard Selling');
  });

  it('refuses to assume a price list in production', () => {
    expect(problemsOf(production({ ERPNEXT_PRICE_LIST: undefined }))).toContain(
      'ERPNEXT_PRICE_LIST must be set explicitly in production (the ERPNext selling price list for website prices)',
    );
    // Development keeps the convenient default.
    expect(loadConfig(testEnv(erp.url)).erpnext.priceList).toBe('MRP');
  });

  it('refuses a production ERPNext host that is not allowlisted', () => {
    expect(problemsOf(production({ ERPNEXT_PRICE_LIST: 'MRP', ERPNEXT_ALLOWED_HOSTS: 'erp.example.com' }))).toContain(
      'ERPNEXT_BASE_URL host is not in ERPNEXT_ALLOWED_HOSTS',
    );
  });

  it('Lead sync is on by default and can be switched off', () => {
    expect(loadConfig(testEnv(erp.url)).erpnext.leadSync).toBe(true);
    expect(loadConfig(testEnv(erp.url, { ERPNEXT_LEAD_SYNC: 'false' })).erpnext.leadSync).toBe(false);
  });
});

describe('ERPNext client', () => {
  const client = () => new ErpNextClient({ baseUrl: new URL(erp.url), apiKey: TEST_API_KEY, apiSecret: TEST_API_SECRET, timeoutMs: 1000 });

  it('reports rate limiting clearly, without the upstream body', async () => {
    erp.override.set('/api/resource/Item', (_req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ exception: 'Traceback (most recent call last)' }));
    });
    const err = await client()
      .getList('Item', { fields: ['name'] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErpNextError);
    expect(err).toMatchObject({ kind: 'upstream', status: 429, message: 'ERPNext rate limit reached' });
  });

  it('calls read-only whitelisted methods and rejects anything that is not a method name', async () => {
    expect(await client().getMethod('frappe.auth.get_logged_user')).toBe('website-api@example.com');
    await expect(client().getMethod('../api/resource/Item')).rejects.toMatchObject({ kind: 'validation' });
    await expect(client().getMethod('frappe')).rejects.toMatchObject({ kind: 'validation' });
  });

  it('maps rejected credentials to an auth error', async () => {
    const bad = new ErpNextClient({ baseUrl: new URL(erp.url), apiKey: 'wrong-key-123', apiSecret: 'wrong-secret-123', timeoutMs: 1000 });
    await expect(bad.getMethod('frappe.auth.get_logged_user')).rejects.toMatchObject({ kind: 'auth', status: 403 });
  });
});

describe('ERPNEXT_LEAD_SYNC=false (read-only against ERPNext)', () => {
  const inquiry = { name: 'Meena Shah', message: 'Need 50 packets of tomato seeds.' };

  it('stores inquiries locally as queued and never writes to ERPNext', async () => {
    const { app, repos } = buildTestApp(erp.url, { env: { ERPNEXT_LEAD_SYNC: 'false' } });
    const customer = await customerSession(app, repos, { email: 'meena@example.com' });
    const res = await customer.post('/api/inquiries', inquiry);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ crmSync: 'queued', duplicate: false });
    expect(erp.leads).toHaveLength(0);
    expect(erp.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
    // Still pending (not failed), so it is sent once Lead sync is switched back on.
    expect([...repos.inquiries.rows.values()][0]!.syncStatus).toBe('pending');
  });

  it('refuses the admin "retry sync" action instead of creating a Lead', async () => {
    const ctx = buildTestApp(erp.url, { env: { ERPNEXT_LEAD_SYNC: 'false' } });
    await ctx.repos.users.create({ email: 'admin@example.com', passwordHash: await hashPassword('Correct-Horse-42'), role: 'admin' });
    const customer = await customerSession(ctx.app, ctx.repos, { email: 'meena@example.com' });
    const sent = await customer.post('/api/inquiries', inquiry);
    const agent = request.agent(ctx.app);
    const login = await agent.post('/api/auth/login').set('Origin', ALLOWED_ORIGIN).send({ email: 'admin@example.com', password: 'Correct-Horse-42' });
    const retry = await agent
      .post(`/api/admin/inquiries/${sent.body.reference}/retry-sync`)
      .set('Origin', ALLOWED_ORIGIN)
      .set('X-CSRF-Token', login.body.csrfToken);
    expect(retry.status).toBe(409);
    expect(retry.body.error.message).toContain('ERPNEXT_LEAD_SYNC=false');
    expect(erp.leads).toHaveLength(0);
  });

  it('still reads the live catalogue (products, categories, prices)', async () => {
    const { app } = buildTestApp(erp.url, { env: { ERPNEXT_LEAD_SYNC: 'false' } });
    const products = await request(app).get('/api/products');
    expect(products.status).toBe(200);
    expect(products.body.total).toBeGreaterThan(0);
    expect((await request(app).get('/api/categories')).body.items.length).toBeGreaterThan(0);
  });
});

describe('ERPNEXT_PRICE_SYNC=false (catalogue without selling prices)', () => {
  /** As on the production site today: Item and Item Group readable, Item Price / Price List forbidden. */
  const forbidPrices = () => {
    for (const path of ['/api/resource/Item Price', '/api/resource/Price List']) {
      erp.override.set(path, (_req, res) => {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ exc_type: 'PermissionError' }));
      });
    }
  };
  const noPrices = { ERPNEXT_PRICE_SYNC: 'false', ERPNEXT_CATALOG_SOURCE: 'item' };
  const priceRequests = () => erp.requests.filter((r) => r.path.startsWith('/api/resource/Item Price') || r.path.startsWith('/api/resource/Price List'));

  it('does not need ERPNEXT_PRICE_LIST in production', () => {
    const env = testEnv('https://asfsl.sanvidhierp.in/', {
      NODE_ENV: 'production',
      ORIGIN_SHARED_SECRET: 'test-origin-secret-0123456789abcdefghij',
      ERPNEXT_ALLOWED_HOSTS: 'asfsl.sanvidhierp.in',
      ERPNEXT_PRICE_SYNC: 'false',
      ERPNEXT_LEAD_SYNC: 'false',
      CORS_ALLOWED_ORIGINS: 'https://shop.example.com',
      APP_PUBLIC_URL: 'https://shop.example.com',
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'mailer',
      SMTP_PASS: 'smtp-password-123',
      MAIL_FROM: 'Agrismart <no-reply@shop.example.com>',
    });
    expect(problemsOf(env)).toEqual([]);
    expect(loadConfig(env).erpnext.priceSync).toBe(false);
  });

  it('lists every enabled saleable Item with its categories and no price, without requesting prices', async () => {
    forbidPrices();
    const { app } = buildTestApp(erp.url, { env: noPrices });
    const res = await request(app).get('/api/products');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5); // all Items (item source), not only published Website Items
    for (const p of res.body.items as { price: unknown; categoryPath: unknown[] }[]) {
      expect(p.price).toBeNull(); // never defaulted or invented
      expect(p.categoryPath.length).toBeGreaterThan(0);
    }
    const detail = await request(app).get('/api/products/SEED-001');
    expect(detail.body).toMatchObject({ itemCode: 'SEED-001', price: null, categoryLabel: 'Vegetable Seeds' });
    const cats = (await request(app).get('/api/categories')).body.items as { name: string; count: number }[];
    expect(cats.find((c) => c.name === 'SEEDS')?.count).toBe(3);
    expect(priceRequests()).toHaveLength(0);
  });

  it('category filters and search work, and price sorting keeps unpriced items listed', async () => {
    const { app } = buildTestApp(erp.url, { env: noPrices });
    expect((await request(app).get('/api/products').query({ category: 'IRRIGATION' })).body.items.map((p: { itemCode: string }) => p.itemCode)).toEqual(['TOOL-100']);
    expect((await request(app).get('/api/products').query({ q: 'tomato' })).body.total).toBe(1);
    expect((await request(app).get('/api/products').query({ sort: 'price_asc' })).body.total).toBe(5);
  });

  it('unpriced products cannot be ordered: the cart refuses them instead of using a made-up price', async () => {
    const { app } = buildTestApp(erp.url, { env: noPrices });
    const quote = await request(app).post('/api/cart/quote').set('Origin', ALLOWED_ORIGIN).send({ items: [{ itemCode: 'SEED-001', qty: 1 }] });
    expect(quote.status).toBe(422);
    expect(quote.body.error.details.items).toEqual([{ itemCode: 'SEED-001', reason: 'price_unavailable' }]);
  });

  it('with price sync ON, forbidden Item Price access is a clear 503, never mock or default data', async () => {
    forbidPrices();
    const { app } = buildTestApp(erp.url);
    const res = await request(app).get('/api/products');
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toMatch(/PermissionError|Traceback/);
  });

  it('mock development mode keeps prices (price sync on by default)', async () => {
    const { app } = buildTestApp(erp.url);
    const seed = (await request(app).get('/api/products/SEED-001')).body;
    expect(seed.price).toEqual({ amount: 249.5, currency: 'INR' });
  });
});
