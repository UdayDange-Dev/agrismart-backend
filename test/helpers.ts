import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import type { Express } from 'express';
import request from 'supertest';
import { buildServices, createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config/env.js';
import { ErpNextClient } from '../src/integrations/erpnext/client.js';
import { createLogger } from '../src/lib/logger.js';
import { hashPassword } from '../src/lib/password.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import type { Repositories } from '../src/repositories/types.js';
import { MemoryMailer } from '../src/services/mailer.js';
import { todayInTimezone } from '../src/services/pricing.js';
import { ITEM_GROUP_TREE } from './fixtures/itemGroups.js';

export const TEST_API_KEY = 'testkey-abcdef123456';
export const TEST_API_SECRET = 'testsecret-SHOULD-NEVER-LEAK-987';
export const ALLOWED_ORIGIN = 'http://localhost:5173';
export const EVIL_ORIGIN = 'https://evil.example';

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: string;
}

type Handler = (req: RecordedRequest, res: ServerResponse) => void | Promise<void>;

const today = todayInTimezone('Asia/Kolkata');
const shift = (days: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Default fixture data, representative of the standard ERPNext doctypes. Items sit in leaf groups
 * of Agrismart's real Item Group tree (test/fixtures/itemGroups.ts), as they do in ERPNext.
 */
export const fixtures = {
  priceList: { name: 'MRP', enabled: 1, selling: 1, currency: 'INR' },
  itemGroups: ITEM_GROUP_TREE.map(([name, parent]) => ({ name, parent_item_group: parent })),
  items: [
    { item_code: 'SEED-001', item_name: 'Hybrid Tomato Seeds', item_group: 'VEGETABLE SEEDS', description: '<p>High <b>yield</b> seeds</p><script>alert(1)</script>', image: '/files/tomato.png', stock_uom: 'Nos' },
    { item_code: 'FERT-010', item_name: 'Organic Fertilizer 5kg', item_group: 'CITY COMPOST', description: 'Bag of compost', image: null, stock_uom: 'Nos' },
    { item_code: 'TOOL-100', item_name: 'Drip Kit', item_group: 'DRIP KIT', description: 'Drip irrigation kit', image: '/private/files/secret.png', stock_uom: 'Nos' },
    { item_code: 'UNPUB-1', item_name: 'Unpublished Item', item_group: 'VEGETABLE SEEDS', description: '', image: null, stock_uom: 'Nos' },
    { item_code: 'EXPIRED-1', item_name: 'Expired Price Item', item_group: 'FIELD CROP SEEDS', description: '', image: null, stock_uom: 'Nos' },
  ],
  websiteItems: [
    { item_code: 'SEED-001', web_item_name: 'Hybrid Tomato Seeds (100g)', website_image: '/files/tomato.png', short_description: null, web_long_description: null },
    { item_code: 'FERT-010', web_item_name: null, website_image: null, short_description: 'Organic compost', web_long_description: null },
    { item_code: 'TOOL-100', web_item_name: null, website_image: '/private/files/secret.png', short_description: null, web_long_description: null },
    { item_code: 'EXPIRED-1', web_item_name: null, website_image: null, short_description: null, web_long_description: null },
  ],
  itemPrices: [
    { item_code: 'SEED-001', price_list_rate: 249.5, currency: 'INR', uom: 'Nos', valid_from: shift(-30), valid_upto: null, customer: null, batch_no: null },
    { item_code: 'SEED-001', price_list_rate: 1, currency: 'INR', uom: 'Nos', valid_from: shift(-10), valid_upto: null, customer: 'Special Customer', batch_no: null },
    { item_code: 'FERT-010', price_list_rate: 399, currency: 'INR', uom: null, valid_from: null, valid_upto: null, customer: null, batch_no: null },
    { item_code: 'TOOL-100', price_list_rate: 1500, currency: 'INR', uom: 'Box', valid_from: null, valid_upto: null, customer: null, batch_no: null },
    { item_code: 'EXPIRED-1', price_list_rate: 99, currency: 'INR', uom: 'Nos', valid_from: shift(-60), valid_upto: shift(-1), customer: null, batch_no: null },
  ],
};

// 1x1 transparent PNG
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

export interface StubErp {
  url: string;
  requests: RecordedRequest[];
  leads: Record<string, unknown>[];
  comments: Record<string, unknown>[];
  /** 'E-commerce User' documents by name (naming series ECU-.YYYY.-.#####). */
  ecommerceUsers: Map<string, Record<string, unknown>>;
  /** Override handling for a path prefix, e.g. '/api/resource/Lead'. */
  override: Map<string, Handler>;
  close(): Promise<void>;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

export async function startStubErp(): Promise<StubErp> {
  const requests: RecordedRequest[] = [];
  const leads: Record<string, unknown>[] = [];
  const comments: Record<string, unknown>[] = [];
  const ecommerceUsers = new Map<string, Record<string, unknown>>();
  let ecommerceSeq = 0;
  const override = new Map<string, Handler>();

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url ?? '/', 'http://stub');
    const rec: RecordedRequest = {
      method: req.method ?? 'GET',
      path: decodeURIComponent(url.pathname),
      query: url.searchParams,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    requests.push(rec);

    for (const [prefix, handler] of override) {
      if (rec.path.startsWith(prefix)) return handler(rec, res);
    }
    if (rec.path.startsWith('/files/')) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length });
      return res.end(PNG);
    }
    if (req.headers.authorization !== `token ${TEST_API_KEY}:${TEST_API_SECRET}`) {
      return json(res, 403, { exc_type: 'PermissionError', exception: 'Traceback (most recent call last)...' });
    }
    if (rec.path === '/api/method/frappe.auth.get_logged_user') return json(res, 200, { message: 'website-api@example.com' });
    if (rec.path === '/api/resource/Price List/MRP') return json(res, 200, { data: fixtures.priceList });
    if (rec.path.startsWith('/api/resource/Price List/')) return json(res, 404, { exc_type: 'DoesNotExistError' });
    const page = (rows: unknown[]) => {
      const start = Number(rec.query.get('limit_start') ?? 0);
      const len = Number(rec.query.get('limit_page_length') ?? 20);
      return { data: rows.slice(start, start + len) };
    };
    if (rec.path === '/api/resource/Item') return json(res, 200, page(fixtures.items));
    if (rec.path === '/api/resource/Website Item') return json(res, 200, page(fixtures.websiteItems));
    if (rec.path === '/api/resource/Item Price') return json(res, 200, page(fixtures.itemPrices));
    if (rec.path === '/api/resource/Item Group') return json(res, 200, page(fixtures.itemGroups));
    if (rec.path === '/api/resource/Price List') return json(res, 200, page([fixtures.priceList]));
    if (rec.path === '/api/resource/Company') return json(res, 200, page([{ name: 'AGRI SMART FARM SOLUTIONS LLP' }]));
    if (rec.path === '/api/resource/Lead' && rec.method === 'GET') {
      const email = (JSON.parse(rec.query.get('filters') ?? '[]') as [string, string, string][]).find((f) => f[0] === 'email_id')?.[2];
      return json(res, 200, { data: leads.filter((l) => l.email_id === email).map((l) => ({ name: l.name })) });
    }
    if (rec.path === '/api/resource/Lead' && rec.method === 'POST') {
      const doc = { ...(JSON.parse(rec.body) as Record<string, unknown>), name: `CRM-LEAD-${String(leads.length + 1).padStart(5, '0')}` };
      leads.push(doc);
      return json(res, 200, { data: doc });
    }
    if (rec.path === '/api/resource/Comment' && rec.method === 'POST') {
      const doc = { ...(JSON.parse(rec.body) as Record<string, unknown>), name: `c${comments.length + 1}` };
      comments.push(doc);
      return json(res, 200, { data: doc });
    }
    // "E-commerce User" as configured on the production site: named by the naming series
    // ECU-.YYYY.-.##### (ERPNext picks the name), email NOT unique, list filters on email are
    // case-insensitive (MariaDB collation).
    const USERS = '/api/resource/E-commerce User';
    if (rec.path === USERS && rec.method === 'GET') {
      const filters = JSON.parse(rec.query.get('filters') ?? '[]') as [string, string, unknown][];
      const email = filters.find((f) => f[0] === 'email' && f[1] === '=')?.[2];
      const rows = [...ecommerceUsers.values()].filter((u) => email === undefined || String(u.email).toLowerCase() === String(email).toLowerCase());
      return json(res, 200, page(rows.map((u) => ({ name: u.name }))));
    }
    if (rec.path === USERS && rec.method === 'POST') {
      const doc = JSON.parse(rec.body) as Record<string, unknown>;
      if (doc.naming_series !== 'ECU-.YYYY.-.#####') return json(res, 417, { exc_type: 'ValidationError' });
      ecommerceSeq += 1;
      const name = `ECU-${new Date().getFullYear()}-${String(ecommerceSeq).padStart(5, '0')}`;
      const saved = { ...doc, name };
      ecommerceUsers.set(name, saved);
      return json(res, 200, { data: saved });
    }
    if (rec.path.startsWith(`${USERS}/`)) {
      const name = rec.path.slice(USERS.length + 1);
      const existing = ecommerceUsers.get(name);
      if (!existing) return json(res, 404, { exc_type: 'DoesNotExistError' });
      if (rec.method === 'GET') return json(res, 200, { data: existing });
      if (rec.method === 'PUT') {
        Object.assign(existing, JSON.parse(rec.body) as Record<string, unknown>);
        return json(res, 200, { data: existing });
      }
    }
    json(res, 404, { exc_type: 'DoesNotExistError' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    leads,
    comments,
    ecommerceUsers,
    override,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function testEnv(erpUrl: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/agrismart-test',
    ERPNEXT_BASE_URL: erpUrl,
    ERPNEXT_ALLOWED_HOSTS: '127.0.0.1',
    ERPNEXT_API_KEY: TEST_API_KEY,
    ERPNEXT_API_SECRET: TEST_API_SECRET,
    ERPNEXT_TIMEOUT_MS: '1000',
    CORS_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    INQUIRY_SYNC_INTERVAL_SECONDS: '0',
    ...extra,
  };
}

/** Captures everything the logger writes so tests can assert nothing sensitive is logged. */
export function captureLogs() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, stream };
}

export function buildTestApp(
  erpUrl: string,
  opts: { env?: Record<string, string>; configure?: (c: Config) => void; isReady?: () => boolean } = {},
) {
  const config = loadConfig(testEnv(erpUrl, opts.env));
  opts.configure?.(config);
  const logs = captureLogs();
  const logger = createLogger('debug', logs.stream);
  const repos = createMemoryRepositories();
  const erp = new ErpNextClient({
    baseUrl: config.erpnext.baseUrl,
    apiKey: config.erpnext.apiKey,
    apiSecret: config.erpnext.apiSecret,
    timeoutMs: config.erpnext.timeoutMs,
    writes: config.erpnext.writes,
  });
  const mailer = new MemoryMailer();
  const services = buildServices(config, logger, repos, { erp, mailer });
  const app = createApp({ config, logger, repos, services, isReady: opts.isReady ?? (() => true) });
  return { app, config, repos, services, logs, logger, mailer };
}

export const CUSTOMER_PASSWORD = 'Green-Fields-2026';
let customerSeq = 0;

/**
 * Creates a customer directly in the repositories (email confirmed unless `verified: false`),
 * signs in through the real API and returns an agent that sends the allowlisted Origin and the
 * session's CSRF token on every write, as the storefront does.
 */
export async function customerSession(
  app: Express,
  repos: Repositories,
  over: { email?: string; name?: string; phone?: string; verified?: boolean } = {},
) {
  customerSeq += 1;
  const email = over.email ?? `customer${customerSeq}@example.com`;
  const customer = await repos.customers.create({
    email,
    name: over.name ?? 'Asha Patil',
    phone: over.phone ?? '+919876543210',
    passwordHash: await hashPassword(CUSTOMER_PASSWORD),
  });
  if (over.verified !== false) await repos.customers.markEmailVerified(customer.id, new Date());
  const agent = request.agent(app);
  const login = await agent.post('/api/customer/auth/login').set('Origin', ALLOWED_ORIGIN).send({ email, password: CUSTOMER_PASSWORD });
  if (login.status !== 200) throw new Error(`customer sign-in failed with ${login.status}`);
  const csrf = login.body.csrfToken as string;
  const write = (method: 'post' | 'patch' | 'delete') => (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    agent[method](path).set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', csrf).set(headers).send(body as object);
  return { id: customer.id, email, agent, csrf, post: write('post'), patch: write('patch'), del: write('delete') };
}
export type CustomerSession = Awaited<ReturnType<typeof customerSession>>;
