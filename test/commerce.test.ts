import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ErpNextClient } from '../src/integrations/erpnext/client.js';
import { ErpNextLeadGateway, syncInquiry } from '../src/services/leadSync.js';
import { ALLOWED_ORIGIN, buildTestApp, customerSession, PNG, startStubErp, TEST_API_KEY, TEST_API_SECRET, type StubErp } from './helpers.js';

let erp: StubErp;
beforeAll(async () => {
  erp = await startStubErp();
});
afterAll(() => erp.close());
beforeEach(() => {
  erp.override.clear();
  erp.leads.length = 0;
  erp.comments.length = 0;
  erp.requests.length = 0;
});

const order = (items = [{ itemCode: 'SEED-001', qty: 2 }]) => ({
  customer: { name: 'Asha Patil', phone: '9876543210' },
  shippingAddress: { line1: '12 Farm Road', city: 'Pune', state: 'Maharashtra', postalCode: '411001' },
  items,
  acceptTerms: true,
});

describe('catalogue API', () => {
  it('lists products with server-side search, category filter and pagination', async () => {
    const { app } = buildTestApp(erp.url);
    const all = await request(app).get('/api/products');
    expect(all.status).toBe(200);
    expect(all.headers['cache-control']).toBe('public, max-age=60');
    expect(all.body.total).toBe(4);
    const seed = all.body.items.find((p: { itemCode: string }) => p.itemCode === 'SEED-001');
    expect(seed).toEqual({
      itemCode: 'SEED-001',
      name: 'Hybrid Tomato Seeds (100g)',
      description: 'High yield seeds',
      category: 'VEGETABLE SEEDS',
      categoryLabel: 'Vegetable Seeds',
      categoryPath: [
        { name: 'SEEDS', label: 'Seeds' },
        { name: 'VEGETABLE SEEDS', label: 'Vegetable Seeds' },
      ],
      uom: 'Nos',
      price: { amount: 249.5, currency: 'INR' },
      imageUrl: '/api/products/SEED-001/image',
    });

    const search = await request(app).get('/api/products').query({ q: 'tomato' });
    expect(search.body.items.map((p: { itemCode: string }) => p.itemCode)).toEqual(['SEED-001']);
    const regexy = await request(app).get('/api/products').query({ q: '.*(a+)+$' });
    expect(regexy.status).toBe(200);
    expect(regexy.body.total).toBe(0);
    const cat = await request(app).get('/api/products').query({ category: 'Fertilizers' });
    expect(cat.body.items.map((p: { itemCode: string }) => p.itemCode)).toEqual(['FERT-010']);
    const paged = await request(app).get('/api/products').query({ pageSize: 1, page: 2 });
    expect(paged.body.items).toHaveLength(1);
    expect((await request(app).get('/api/products').query({ pageSize: 1000 })).status).toBe(400);
  });

  it('returns categories and product details, 404 for unknown products', async () => {
    const { app } = buildTestApp(erp.url);
    const cats = await request(app).get('/api/categories');
    expect(cats.body.items).toContainEqual({
      name: 'SEEDS',
      label: 'Seeds',
      count: 2,
      children: [
        { name: 'FIELD CROP SEEDS', label: 'Field Crop Seeds', count: 1 },
        { name: 'VEGETABLE SEEDS', label: 'Vegetable Seeds', count: 1 },
      ],
    });
    expect((await request(app).get('/api/products/FERT-010')).body.name).toBe('Organic Fertilizer 5kg');
    expect((await request(app).get('/api/products/UNPUB-1')).status).toBe(404);
    expect((await request(app).get('/api/products/..%2F..%2Fetc')).status).toBe(400);
  });

  it('lists every top-level ERPNext Item Group, alphabetically by label, with subtree counts', async () => {
    const { app } = buildTestApp(erp.url);
    const cats = (await request(app).get('/api/categories')).body.items as { name: string; label: string; count: number }[];
    expect(cats.map((c) => c.label)).toEqual([
      'Crop Nutrition',
      'Crop Protection',
      'Electrical & Control',
      'Equipments',
      'Gardening & Landscaping',
      'Hardware',
      'Irrigation',
      'Planting Material',
      'Protected Agriculture',
      'Seeds',
      'Solar',
      'Water Pumps & Motors',
    ]);
    expect(cats.find((c) => c.name === 'IRRIGATION')).toMatchObject({ count: 1, children: [{ name: 'DRIP IRRIGATION', count: 1 }] });
    expect(cats.find((c) => c.name === 'SOLAR')).toMatchObject({ count: 0, children: [] });
  });

  it('filters by any level of the Item Group tree, case-insensitively, with special characters', async () => {
    const { app } = buildTestApp(erp.url);
    const codes = async (category: string) =>
      ((await request(app).get('/api/products').query({ category })).body.items as { itemCode: string }[]).map((p) => p.itemCode).sort();
    expect(await codes('IRRIGATION')).toEqual(['TOOL-100']); // top level -> leaf "DRIP KIT"
    expect(await codes('DRIP KITS')).toEqual(['TOOL-100']); // intermediate group
    expect(await codes('DRIP KIT')).toEqual(['TOOL-100']); // the item's own group
    expect(await codes('Irrigation')).toEqual(['TOOL-100']); // readable label works too
    expect(await codes('SEEDS')).toEqual(['EXPIRED-1', 'SEED-001']);
    expect(await codes('CROP NUTRITION')).toEqual(['FERT-010']);
    expect(await codes('WATER PUMPS & MOTORS')).toEqual([]); // valid group, no products yet
    expect(await codes('Seed')).toEqual([]); // no partial matches
    const raw = await request(app).get('/api/products?category=WATER%20PUMPS%20%26%20MOTORS');
    expect(raw.status).toBe(200);
    expect(raw.body.total).toBe(0);
  });

  it('falls back to flat item groups when the Item Group tree cannot be read', async () => {
    erp.override.set('/api/resource/Item Group', (_req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ exc_type: 'PermissionError' }));
    });
    try {
      const { app } = buildTestApp(erp.url);
      const cats = (await request(app).get('/api/categories')).body.items as { name: string }[];
      expect(cats.map((c) => c.name)).toEqual(['CITY COMPOST', 'DRIP KIT', 'FIELD CROP SEEDS', 'VEGETABLE SEEDS']);
      const res = await request(app).get('/api/products').query({ category: 'DRIP KIT' });
      expect(res.body.items.map((p: { itemCode: string }) => p.itemCode)).toEqual(['TOOL-100']);
      expect(res.body.items[0].categoryPath).toEqual([{ name: 'DRIP KIT', label: 'Drip Kit' }]);
    } finally {
      erp.override.delete('/api/resource/Item Group');
    }
  });

  it('proxies product images safely', async () => {
    const { app } = buildTestApp(erp.url);
    const img = await request(app).get('/api/products/SEED-001/image');
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(Buffer.from(img.body as Buffer).equals(PNG)).toBe(true);
    expect((await request(app).get('/api/products/TOOL-100/image')).status).toBe(404); // private file
  });
});

describe('cart pricing', () => {
  it('prices the cart from ERPNext prices, merging duplicate lines', async () => {
    const { app } = buildTestApp(erp.url);
    const res = await request(app)
      .post('/api/cart/quote')
      .send({
        items: [
          { itemCode: 'SEED-001', qty: 2 },
          { itemCode: 'FERT-010', qty: 1 },
          { itemCode: 'SEED-001', qty: 1 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.currency).toBe('INR');
    expect(res.body.lines).toEqual([
      { itemCode: 'SEED-001', name: 'Hybrid Tomato Seeds (100g)', uom: 'Nos', qty: 3, unitPrice: 249.5, lineTotal: 748.5 },
      { itemCode: 'FERT-010', name: 'Organic Fertilizer 5kg', uom: 'Nos', qty: 1, unitPrice: 399, lineTotal: 399 },
    ]);
    expect(res.body.subtotal).toBe(1147.5);
  });

  it('refuses items with expired, missing or mismatched prices', async () => {
    const { app } = buildTestApp(erp.url);
    const res = await request(app)
      .post('/api/cart/quote')
      .send({
        items: [
          { itemCode: 'EXPIRED-1', qty: 1 },
          { itemCode: 'TOOL-100', qty: 1 },
          { itemCode: 'NOPE', qty: 1 },
        ],
      });
    expect(res.status).toBe(422);
    expect(res.body.error.details.items).toEqual([
      { itemCode: 'EXPIRED-1', reason: 'price_unavailable' },
      { itemCode: 'TOOL-100', reason: 'price_unavailable' },
      { itemCode: 'NOPE', reason: 'not_available' },
    ]);
  });

  it('rejects invalid quantities', async () => {
    const { app } = buildTestApp(erp.url);
    for (const qty of [0, -1, 1.5, 100000, '2']) {
      expect((await request(app).post('/api/cart/quote').send({ items: [{ itemCode: 'SEED-001', qty }] })).status).toBe(400);
    }
  });
});

describe('order requests', () => {
  it('creates a server-priced order request for a verified customer and enforces ownership via access token (IDOR)', async () => {
    const { app, repos } = buildTestApp(erp.url);
    const buyer = await customerSession(app, repos);
    const res = await buyer.post('/api/orders', order());
    expect(res.status).toBe(201);
    expect(res.body.order.subtotal).toBe(499);
    expect(res.body.order.status).toBe('pending_review');
    expect(res.body.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ref = res.body.order.reference as string;
    // No Sales Order, Customer or any other write reached ERPNext.
    expect(erp.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
    // Only the token hash is stored; the order belongs to the session's customer and email.
    const stored = repos.orders.rows.get(ref)!;
    expect(JSON.stringify(stored)).not.toContain(res.body.accessToken);
    expect(stored.customerId).toBe(buyer.id);
    expect(stored.customer.email).toBe(buyer.email);

    const own = await request(app).get(`/api/orders/${ref}`).set('X-Order-Token', res.body.accessToken);
    expect(own.status).toBe(200);
    expect(own.body.customerName).toBe('Asha Patil');
    expect(own.body).not.toHaveProperty('customer');

    const other = await buyer.post('/api/orders', order());
    const wrong = await request(app).get(`/api/orders/${ref}`).set('X-Order-Token', other.body.accessToken);
    expect(wrong.status).toBe(404);
    expect((await request(app).get(`/api/orders/${ref}`)).status).toBe(400);
    expect((await request(app).get('/api/orders/AGS-AAAAAAAAAA').set('X-Order-Token', res.body.accessToken)).status).toBe(404);
  });

  it('refuses visitors and unverified customers (no guest checkout)', async () => {
    const { app, repos } = buildTestApp(erp.url);
    const anon = await request(app).post('/api/orders').set('Origin', ALLOWED_ORIGIN).send(order());
    expect(anon.status).toBe(401);
    expect(anon.body.error.code).toBe('unauthorized');
    const unverified = await customerSession(app, repos, { verified: false });
    const blocked = await unverified.post('/api/orders', order());
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('email_unverified');
    expect(repos.orders.rows.size).toBe(0);
  });

  it('takes the email from the account, never from the request body', async () => {
    const { app, repos } = buildTestApp(erp.url);
    const buyer = await customerSession(app, repos);
    const spoofed = { ...order(), customer: { ...order().customer, email: 'victim@example.com' } };
    expect((await buyer.post('/api/orders', spoofed)).status).toBe(400);
    expect((await buyer.post('/api/orders', { ...order(), customerId: 'someone-else' })).status).toBe(400);
  });

  it('is idempotent with an Idempotency-Key header, but only for the customer who used it', async () => {
    const { app, repos } = buildTestApp(erp.url);
    const buyer = await customerSession(app, repos);
    const key = { 'Idempotency-Key': 'checkout-attempt-1234567890' };
    const first = await buyer.post('/api/orders', order(), key);
    const second = await buyer.post('/api/orders', order(), key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.accessToken).toBeNull();
    expect(second.body.order.reference).toBe(first.body.order.reference);
    // Another customer replaying the key gets no view of the first customer's order.
    const other = await customerSession(app, repos);
    const replay = await other.post('/api/orders', order(), key);
    expect(replay.status).toBe(409);
    expect(JSON.stringify(replay.body)).not.toContain(first.body.order.reference);
    expect(repos.orders.rows.size).toBe(1);
  });

  it('requires terms acceptance and a valid address', async () => {
    const { app, repos } = buildTestApp(erp.url);
    const buyer = await customerSession(app, repos);
    expect((await buyer.post('/api/orders', { ...order(), acceptTerms: false })).status).toBe(400);
    expect((await buyer.post('/api/orders', { ...order(), shippingAddress: { line1: 'x' } })).status).toBe(400);
    expect((await buyer.post('/api/orders', { ...order(), subtotal: 1 })).status).toBe(400);
  });

  it('optionally saves the delivery address to the customer address book', async () => {
    const { app, repos } = buildTestApp(erp.url);
    const buyer = await customerSession(app, repos);
    const res = await buyer.post('/api/orders', { ...order(), saveAddress: true });
    expect(res.status).toBe(201);
    expect(res.body.addressSaved).toBe(true);
    const book = await buyer.agent.get('/api/customer/addresses');
    expect(book.body.items).toEqual([
      { id: expect.any(String), label: null, line1: '12 Farm Road', line2: null, city: 'Pune', state: 'Maharashtra', postalCode: '411001', country: 'India' },
    ]);
  });
});

describe('inquiries and ERPNext Leads', () => {
  const inquiry = {
    name: 'Meena Shah',
    phone: '+91 98765 43210',
    company: 'Shah Farms',
    productInterest: 'SEED-001',
    message: 'Need 50 packets of tomato seeds.',
  };
  const meena = { email: 'Meena@Example.com'.toLowerCase(), name: 'Meena Shah' };

  it('stores the inquiry for the signed-in customer and creates a Lead with standard fields only', async () => {
    const { app, repos } = buildTestApp(erp.url);
    const customer = await customerSession(app, repos, meena);
    const res = await customer.post('/api/inquiries', inquiry);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'received', crmSync: 'synced', duplicate: false });
    expect(res.body.reference).toMatch(/^INQ-/);
    expect(erp.leads).toHaveLength(1);
    expect(Object.keys(erp.leads[0]!).sort()).toEqual(['company_name', 'email_id', 'first_name', 'lead_name', 'mobile_no', 'name']);
    expect(erp.leads[0]!.email_id).toBe('meena@example.com');
    expect(erp.leads[0]!.mobile_no).toBe('+919876543210');
    const stored = [...repos.inquiries.rows.values()][0]!;
    expect(stored).toMatchObject({ syncStatus: 'synced', erpLeadName: 'CRM-LEAD-00001', customerId: customer.id, kind: 'inquiry' });
  });

  it('requires a signed-in customer with a confirmed email; the reply address is the account email', async () => {
    const { app, repos } = buildTestApp(erp.url);
    const anon = await request(app).post('/api/inquiries').set('Origin', ALLOWED_ORIGIN).send(inquiry);
    expect(anon.status).toBe(401);
    const unverified = await customerSession(app, repos, { verified: false });
    expect((await unverified.post('/api/inquiries', inquiry)).body.error.code).toBe('email_unverified');
    const customer = await customerSession(app, repos, meena);
    expect((await customer.post('/api/inquiries', { ...inquiry, email: 'victim@example.com' })).status).toBe(400);
    expect(repos.inquiries.rows.size).toBe(0);
    expect(erp.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('records quotation requests with a quantity and labels them in the ERPNext comment', async () => {
    const { app, repos } = buildTestApp(erp.url);
    const customer = await customerSession(app, repos, meena);
    const res = await customer.post('/api/inquiries', { ...inquiry, kind: 'quotation', quantity: 50 });
    expect(res.status).toBe(202);
    expect(res.body.message).toMatch(/quotation request/);
    expect([...repos.inquiries.rows.values()][0]).toMatchObject({ kind: 'quotation', quantity: 50 });
    expect(erp.comments[0]!.content).toContain('Website quotation request');
    expect(erp.comments[0]!.content).toContain('Quantity: 50');
    expect((await customer.post('/api/inquiries', { ...inquiry, kind: 'order' })).status).toBe(400);
    expect((await customer.post('/api/inquiries', { ...inquiry, quantity: 0 })).status).toBe(400);
    expect((await customer.post('/api/inquiries', { ...inquiry, quantity: 1.5 })).status).toBe(400);
  });

  it('writes nothing to ERPNext when ERPNEXT_LEAD_SYNC=false (inquiry stays queued)', async () => {
    const { app, repos } = buildTestApp(erp.url, { env: { ERPNEXT_LEAD_SYNC: 'false' } });
    const customer = await customerSession(app, repos, meena);
    const res = await customer.post('/api/inquiries', inquiry);
    expect(res.status).toBe(202);
    expect(res.body.crmSync).toBe('queued');
    expect(erp.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
    expect(erp.leads).toHaveLength(0);
  });

  it('deduplicates identical submissions (no second Lead)', async () => {
    const { app, repos } = buildTestApp(erp.url);
    const customer = await customerSession(app, repos, meena);
    await customer.post('/api/inquiries', inquiry);
    const again = await customer.post('/api/inquiries', { ...inquiry, message: '  need 50 packets of   TOMATO seeds. ' });
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(erp.leads).toHaveLength(1);
  });

  it('limits inquiries per email per day', async () => {
    const { app, repos } = buildTestApp(erp.url);
    const customer = await customerSession(app, repos, meena);
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await customer.post('/api/inquiries', { ...inquiry, message: `Message number ${i} about seeds` })).status);
    }
    expect(statuses).toEqual([202, 202, 202, 429]);
  });

  it('reports "queued" (not success in ERPNext) when ERPNext times out, then retries without duplicating', async () => {
    const { app, repos, logger } = buildTestApp(erp.url);
    const customer = await customerSession(app, repos, meena);
    erp.override.set('/api/resource/Lead', () => new Promise(() => undefined)); // hang -> timeout
    const res = await customer.post('/api/inquiries', inquiry);
    expect(res.status).toBe(202);
    expect(res.body.crmSync).toBe('queued');
    const stored = [...repos.inquiries.rows.values()][0]!;
    expect(stored.syncStatus).toBe('pending');
    expect(stored.lastErrorKind).toBe('timeout');

    // Simulate that ERPNext actually created the Lead before the timeout.
    erp.override.clear();
    erp.leads.push({ name: 'CRM-LEAD-EXISTING', email_id: 'meena@example.com' });
    const result = await syncInquiry(repos.inquiries, buildGateway(erp.url), stored.id, logger);
    expect(result).toBe('synced');
    expect(erp.leads.filter((l) => l.email_id === 'meena@example.com')).toHaveLength(1);
    expect(repos.inquiries.rows.get(stored.id)!.erpLeadName).toBe('CRM-LEAD-EXISTING');
  });

  it('marks the inquiry failed (no endless retries) when ERPNext rejects permissions', async () => {
    const { app, repos } = buildTestApp(erp.url);
    const customer = await customerSession(app, repos, meena);
    erp.override.set('/api/resource/Lead', (_req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end('{"exc_type":"PermissionError"}');
    });
    const res = await customer.post('/api/inquiries', inquiry);
    expect(res.status).toBe(202);
    expect(res.body.crmSync).toBe('queued');
    expect([...repos.inquiries.rows.values()][0]!.syncStatus).toBe('failed');
  });
});

function buildGateway(url: string) {
  return new ErpNextLeadGateway(
    new ErpNextClient({ baseUrl: new URL(url), apiKey: TEST_API_KEY, apiSecret: TEST_API_SECRET, timeoutMs: 1000, writes: { allowed: true, reason: 'local stub' } }),
    { leadSource: undefined, addComment: true, timezone: 'Asia/Kolkata' },
  );
}
