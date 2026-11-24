import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErpNextClient, ErpNextError } from '../src/integrations/erpnext/client.js';
import { CatalogService, ErpNextCatalogSource, CatalogConfigError } from '../src/services/catalogService.js';
import { createLogger } from '../src/lib/logger.js';
import { fixtures, startStubErp, TEST_API_KEY, TEST_API_SECRET, type StubErp } from './helpers.js';

let erp: StubErp;
const logger = createLogger('silent');

const client = (over: Partial<ConstructorParameters<typeof ErpNextClient>[0]> = {}) =>
  new ErpNextClient({ baseUrl: new URL(erp.url), apiKey: TEST_API_KEY, apiSecret: TEST_API_SECRET, timeoutMs: 500, ...over });

const source = (c = client(), priceList = 'MRP') =>
  new ErpNextCatalogSource(c, { priceList, catalogSource: 'website_item', itemGroups: [], timezone: 'Asia/Kolkata' }, logger);

beforeAll(async () => {
  erp = await startStubErp();
});
afterAll(() => erp.close());

describe('ERPNext client', () => {
  it('sends token auth to the configured host only', async () => {
    await client().getList('Item', { fields: ['item_code'] });
    const last = erp.requests.at(-1)!;
    expect(last.headers.authorization).toBe(`token ${TEST_API_KEY}:${TEST_API_SECRET}`);
  });

  it('maps 401/403 to an auth error without leaking credentials or upstream tracebacks', async () => {
    const err = await client({ apiSecret: 'wrong-secret-123' })
      .getList('Item', { fields: ['item_code'] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErpNextError);
    expect((err as ErpNextError).kind).toBe('auth');
    const text = `${(err as Error).message} ${(err as Error).stack}`;
    expect(text).not.toContain('wrong-secret-123');
    expect(text).not.toContain('Traceback');
  });

  it('times out slow responses', async () => {
    erp.override.set('/api/resource/Slow', () => new Promise(() => undefined));
    const err = await client({ timeoutMs: 1000 })
      .getList('Slow', { fields: ['name'] })
      .catch((e: unknown) => e);
    expect((err as ErpNextError).kind).toBe('timeout');
    erp.override.delete('/api/resource/Slow');
  });

  it('treats a response body that stalls after the headers as a timeout', async () => {
    // Headers and part of the body arrive, then nothing: the timeout fires while the body is read.
    const stall: Parameters<typeof erp.override.set>[1] = (req, res) => {
      const image = req.path.startsWith('/files/');
      res.writeHead(200, { 'Content-Type': image ? 'image/png' : 'application/json' });
      res.write(image ? Buffer.from([0x89, 0x50]) : '{"data": [');
    };
    erp.override.set('/api/resource/Stall', stall);
    erp.override.set('/files/stall.png', stall);
    try {
      const list = await client({ timeoutMs: 500 }).getList('Stall', { fields: ['name'] }).catch((e: unknown) => e);
      expect(list).toBeInstanceOf(ErpNextError);
      expect((list as ErpNextError).kind).toBe('timeout');
      const image = await client({ timeoutMs: 500 }).fetchPublicImage('/files/stall.png').catch((e: unknown) => e);
      expect(image).toBeInstanceOf(ErpNextError);
      expect((image as ErpNextError).kind).toBe('timeout');
    } finally {
      erp.override.delete('/api/resource/Stall');
      erp.override.delete('/files/stall.png');
    }
  });

  it('rejects malformed JSON and unexpected shapes', async () => {
    erp.override.set('/api/resource/Broken', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"data": "not-a-list"');
    });
    erp.override.set('/api/resource/Shape', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"data": "not-a-list"}');
    });
    expect(((await client().getList('Broken', { fields: [] }).catch((e: unknown) => e)) as ErpNextError).kind).toBe('invalid_response');
    expect(((await client().getList('Shape', { fields: [] }).catch((e: unknown) => e)) as ErpNextError).kind).toBe('invalid_response');
  });

  it('refuses to follow redirects', async () => {
    erp.override.set('/api/resource/Redirect', (_req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' });
      res.end();
    });
    const err = await client().getList('Redirect', { fields: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErpNextError);
  });

  it('only fetches public /files/ images and rejects traversal / private / absolute paths', async () => {
    expect((await client().fetchPublicImage('/files/tomato.png')).contentType).toBe('image/png');
    for (const bad of ['/private/files/a.png', '/files/../private/files/a.png', 'http://evil/a.png', '//evil/a.png', '/files/a.svg?x=1']) {
      await expect(client().fetchPublicImage(bad)).rejects.toBeInstanceOf(ErpNextError);
    }
  });

  it('rejects non-image content types (e.g. SVG/HTML) from the image proxy', async () => {
    erp.override.set('/files/evil.svg', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end('<svg onload="alert(1)"/>');
    });
    await expect(client().fetchPublicImage('/files/evil.svg')).rejects.toMatchObject({ kind: 'invalid_response' });
    erp.override.delete('/files/evil.svg');
  });
});

describe('ERPNext catalogue source', () => {
  it('loads only published, priced items with valid public prices', async () => {
    const { products, currency } = await source().load();
    expect(currency).toBe('INR');
    const codes = products.map((p) => p.itemCode).sort();
    expect(codes).toEqual(['EXPIRED-1', 'FERT-010', 'SEED-001', 'TOOL-100']); // UNPUB-1 is not a published Website Item
    const byCode = new Map(products.map((p) => [p.itemCode, p]));
    expect(byCode.get('SEED-001')!.price).toEqual({ amount: 249.5, currency: 'INR' }); // customer price ignored
    expect(byCode.get('EXPIRED-1')!.price).toBeNull(); // expired price
    expect(byCode.get('TOOL-100')!.price).toBeNull(); // UOM mismatch
    expect(byCode.get('TOOL-100')!.imagePath).toBeNull(); // private file never exposed
    expect(byCode.get('SEED-001')!.description).toBe('High yield seeds'); // HTML stripped
  });

  it('filters Item and Item Price queries server-side', async () => {
    erp.requests.length = 0;
    await source().load();
    const itemReq = erp.requests.find((r) => r.path === '/api/resource/Item')!;
    expect(JSON.parse(itemReq.query.get('filters')!)).toEqual(
      expect.arrayContaining([
        ['disabled', '=', 0],
        ['is_sales_item', '=', 1],
      ]),
    );
    const priceReq = erp.requests.find((r) => r.path === '/api/resource/Item Price')!;
    expect(JSON.parse(priceReq.query.get('filters')!)).toEqual(
      expect.arrayContaining([
        ['price_list', '=', 'MRP'],
        ['selling', '=', 1],
      ]),
    );
  });

  it('excludes discontinued items (Item.end_of_life in the past) but keeps future end-of-life dates', async () => {
    const extra = {
      items: [
        { item_code: 'EOL-OLD', item_name: 'Discontinued Sprayer', item_group: 'Tools', description: '', image: null, stock_uom: 'Nos', end_of_life: '2020-01-01' },
        { item_code: 'EOL-FUTURE', item_name: 'Current Sprayer', item_group: 'Tools', description: '', image: null, stock_uom: 'Nos', end_of_life: '2099-12-31' },
      ],
      web: [
        { item_code: 'EOL-OLD', web_item_name: null, website_image: null, short_description: null, web_long_description: null },
        { item_code: 'EOL-FUTURE', web_item_name: null, website_image: null, short_description: null, web_long_description: null },
      ],
      prices: [
        { item_code: 'EOL-OLD', price_list_rate: 900, currency: 'INR', uom: 'Nos', valid_from: null, valid_upto: null, customer: null, batch_no: null },
        { item_code: 'EOL-FUTURE', price_list_rate: 950, currency: 'INR', uom: 'Nos', valid_from: null, valid_upto: null, customer: null, batch_no: null },
      ],
    };
    fixtures.items.push(...(extra.items as never[]));
    fixtures.websiteItems.push(...(extra.web as never[]));
    fixtures.itemPrices.push(...(extra.prices as never[]));
    try {
      const codes = (await source().load()).products.map((p) => p.itemCode);
      expect(codes).toContain('EOL-FUTURE');
      expect(codes).not.toContain('EOL-OLD');
    } finally {
      fixtures.items.splice(-2);
      fixtures.websiteItems.splice(-2);
      fixtures.itemPrices.splice(-2);
    }
  });

  it('pages through large lists in a stable order without losing rows', async () => {
    erp.requests.length = 0;
    const rows = await client().getAll('Item', { fields: ['item_code'], pageSize: 2 });
    expect(rows.map((r) => r.item_code)).toEqual(fixtures.items.map((i) => i.item_code));
    const itemCalls = erp.requests.filter((r) => r.path === '/api/resource/Item');
    expect(itemCalls).toHaveLength(3); // 2 + 2 + 1 rows
    for (const call of itemCalls) expect(call.query.get('order_by')).toBe('name asc');
    expect(itemCalls.map((c) => c.query.get('limit_start'))).toEqual(['0', '2', '4']);
  });

  it('warns when the row cap truncates a list, and only then', async () => {
    const warnings: unknown[] = [];
    const logged = () => client({ logger: { warn: (...args: unknown[]) => void warnings.push(args) } as never });
    const all = fixtures.items.map((i) => i.item_code);

    // cap reached on a full page with rows left over
    expect((await logged().getAll('Item', { fields: ['item_code'], pageSize: 2, maxRows: 4 })).map((r) => r.item_code)).toEqual(all.slice(0, 4));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual([{ doctype: 'Item', maxRows: 4 }, expect.stringContaining('truncated')]);

    // cap that is not a multiple of the page size
    expect(await logged().getAll('Item', { fields: ['item_code'], pageSize: 2, maxRows: 3 })).toHaveLength(3);
    expect(warnings).toHaveLength(2);

    // exactly as many rows as the cap, and a list below the cap: nothing was left out
    expect(await logged().getAll('Item', { fields: ['item_code'], pageSize: all.length, maxRows: all.length })).toHaveLength(all.length);
    expect(await logged().getAll('Item', { fields: ['item_code'], pageSize: 2 })).toHaveLength(all.length);
    expect(warnings).toHaveLength(2);
  });

  it('fails clearly when the configured price list does not exist', async () => {
    await expect(source(client(), 'DOES-NOT-EXIST').load()).rejects.toBeInstanceOf(CatalogConfigError);
  });

  it('serves stale data within the bounded window when ERPNext fails, then reports unavailable', async () => {
    let t = 0;
    let fail = false;
    const flaky = { load: async () => (fail ? Promise.reject(new ErpNextError('timeout', 'x')) : source().load()) };
    const svc = new CatalogService(flaky, { ttlMs: 1000, maxStaleMs: 1000 }, logger, () => t);
    await svc.getCatalog();
    fail = true;
    t = 1500;
    expect((await svc.getCatalog()).products.length).toBeGreaterThan(0);
    t = 2500;
    await expect(svc.getCatalog()).rejects.toMatchObject({ status: 503 });
  });
});
