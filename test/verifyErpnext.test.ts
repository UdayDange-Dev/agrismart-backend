import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { ErpNextClient } from '../src/integrations/erpnext/client.js';
import { checkApiUserPrivilege, maskUser, verifyErpnext } from '../src/integrations/erpnext/verify.js';
import { createLogger } from '../src/lib/logger.js';
import { ErpNextCatalogSource } from '../src/services/catalogService.js';
import { startStubErp, TEST_API_KEY, TEST_API_SECRET, testEnv, type StubErp } from './helpers.js';

/** As on the production site today: Item and Item Group readable, Item Price returns 403, no selling prices. */
let erp: StubErp;
beforeAll(async () => {
  erp = await startStubErp();
});
afterAll(() => erp.close());
beforeEach(() => {
  erp.requests.length = 0;
  erp.override.clear();
  const forbid = (_req: unknown, res: ServerResponse) => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ exc_type: 'PermissionError' }));
  };
  erp.override.set('/api/resource/Item Price', forbid);
});

const config = (extra: Record<string, string>) => loadConfig(testEnv(erp.url, { ERPNEXT_CATALOG_SOURCE: 'item', ERPNEXT_LEAD_SYNC: 'false', ...extra })).erpnext;
const priceRequests = () => erp.requests.filter((r) => /^\/api\/resource\/(Item Price|Price List)/.test(r.path));

async function run(extra: Record<string, string>) {
  const lines: string[] = [];
  const ok = await verifyErpnext(config(extra), { priceListSet: false, log: (l) => lines.push(l) });
  return { ok, out: lines.join('\n') };
}

describe('ErpNextCatalogSource with Item Price forbidden (HTTP 403)', () => {
  const source = (priceSync: boolean) => {
    const c = config({ ERPNEXT_PRICE_SYNC: String(priceSync) });
    const client = new ErpNextClient({ baseUrl: c.baseUrl, apiKey: c.apiKey, apiSecret: c.apiSecret, timeoutMs: c.timeoutMs });
    return new ErpNextCatalogSource(client, c, createLogger('silent'));
  };

  it('price sync off: loads every enabled saleable Item and the Item Group tree, all with price null', async () => {
    const { products, itemGroups, currency } = await source(false).load();
    expect(products.map((p) => p.itemCode).sort()).toEqual(['EXPIRED-1', 'FERT-010', 'SEED-001', 'TOOL-100', 'UNPUB-1']);
    expect(products.every((p) => p.price === null)).toBe(true);
    expect(currency).toBe('');
    expect(itemGroups?.length).toBeGreaterThan(0);
    expect(priceRequests()).toHaveLength(0);
  });

  it('price sync on: the 403 is not swallowed (no default or mock price)', async () => {
    await expect(source(true).load()).rejects.toMatchObject({ kind: 'auth', status: 403 });
  });
});

describe('erpnext:verify', () => {
  it('price sync off: price checks are SKIP, the catalogue load passes and never touches Item Price', async () => {
    const { ok, out } = await run({ ERPNEXT_PRICE_SYNC: 'false' });
    expect(ok).toBe(true);
    expect(out).toContain('price sync OFF (ERPNEXT_PRICE_SYNC=false)');
    expect(out).toMatch(/SKIP {2}Selling price lists/);
    expect(out).toMatch(/SKIP {2}Item Price read/);
    expect(out).toMatch(/OK {4}Catalogue load \(as the website does it\): 5 sellable items in \d+ top-level categories, no Price List \/ Item Price request made/);
    expect(out).not.toContain('FAIL');
    expect(out).toContain('Result: ERPNext integration is ready.');
    expect(priceRequests()).toHaveLength(0); // nothing reached ERPNext
  });

  it('price sync on: Item Price 403 fails the run and suggests ERPNEXT_PRICE_SYNC=false', async () => {
    const { ok, out } = await run({ ERPNEXT_PRICE_SYNC: 'true' });
    expect(ok).toBe(false);
    expect(out).toMatch(/FAIL {2}Item Price read \("MRP"\): auth \(HTTP 403\).*set ERPNEXT_PRICE_SYNC=false/);
    expect(out).toMatch(/FAIL {2}Catalogue load/);
    expect(out).toContain('Result: fix the FAIL items above.');
  });

  it('never prints the API secret', async () => {
    const { out } = await run({ ERPNEXT_PRICE_SYNC: 'false' });
    expect(out).not.toContain(TEST_API_SECRET);
  });
});

describe('API user least-privilege probe (read-only, local stub)', () => {
  const client = () => new ErpNextClient({ baseUrl: new URL(erp.url), apiKey: TEST_API_KEY, apiSecret: TEST_API_SECRET, timeoutMs: 1000 });
  const docType = (status: number) =>
    erp.override.set('/api/resource/DocType/', (_rec, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(status === 200 ? '{"data":{"name":"User"}}' : '{}');
    });

  it('flags a user that can read DocType definitions (System Manager level), with a masked name', async () => {
    docType(200);
    const r = await checkApiUserPrivilege(client());
    expect(r).toMatchObject({ adminLevel: true, user: 'we***@example.com' });
    expect(JSON.stringify(r)).not.toMatch(/website-api@|testkey|testsecret/);
    // Only reads were made.
    expect(erp.requests.filter((x) => x.method !== 'GET')).toHaveLength(0);
  });

  it('passes a user without administrator-level access, and says so when it cannot tell', async () => {
    docType(403);
    expect(await checkApiUserPrivilege(client())).toMatchObject({ adminLevel: false });
    docType(500);
    expect(await checkApiUserPrivilege(client())).toMatchObject({ adminLevel: null });
  });

  it('masks user names', () => {
    expect(maskUser('website-api@agrismart.example')).toBe('we***@agrismart.example');
    expect(maskUser('a@b.c')).toBe('a***@b.c');
    expect(maskUser('Administrator')).toBe('Ad***');
  });
});
