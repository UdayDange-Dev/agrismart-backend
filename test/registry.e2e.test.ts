import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServices, createApp, type Services } from '../src/app.js';
import { loadConfig, type Config } from '../src/config/env.js';
import { applyMongooseHardening } from '../src/db/mongo.js';
import { isLoopbackHost, runtimeWriteBlock } from '../src/integrations/erpnext/writeGuard.js';
import { createLogger } from '../src/lib/logger.js';
import { createMongoRepositories, ensureMongoIndexes } from '../src/repositories/mongo/index.js';
import type { Repositories } from '../src/repositories/types.js';
import { MemoryMailer } from '../src/services/mailer.js';
import { REGISTRY_DOCTYPE, runRegistryJobOnce } from '../src/services/userRegistry.js';
import { ALLOWED_ORIGIN, startStubErp, testEnv, type StubErp } from './helpers.js';

/**
 * OPT-IN end-to-end test of the E-commerce User registry sync:
 *
 *   cd Backend && npm run test:registry-e2e        (or REGISTRY_E2E=1 npx vitest run test/registry.e2e.test.ts)
 *
 * Real HTTP against the real API on 127.0.0.1, real MongoDB (in-memory server), a MOCK ERPNext
 * HTTP server on 127.0.0.1 and an in-memory mailer. Production cannot be reached:
 *  - every outgoing request of this process is checked first: anything that is not 127.0.0.1 /
 *    localhost is refused before a socket is opened;
 *  - ERPNEXT_BASE_URL points at the mock, and this is a test runtime, so the write guard refuses
 *    the production host whatever the configuration says;
 *  - Backend/.env is never loaded; emails go to memory, never to SMTP.
 * Skipped by a plain `npm test`.
 */
const enabled = process.env.REGISTRY_E2E === '1' || process.env.npm_lifecycle_event === 'test:registry-e2e';
const PRODUCTION = 'https://asfsl.sanvidhierp.in/api/resource/E-commerce%20User';

describe.runIf(enabled)('E-commerce User registry: end-to-end against a mock ERPNext (opt-in)', () => {
  let mongo: MongoMemoryServer;
  let conn: mongoose.Connection;
  let erp: StubErp;
  let config: Config;
  let repos: Repositories;
  let services: Services;
  let mailer: MemoryMailer;
  let server: Server;
  let base: string;
  const realFetch = globalThis.fetch;
  const blocked: string[] = [];

  const api = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const runJob = (at = new Date()) =>
    runRegistryJobOnce(repos.customers, services.userRegistry, services.registryAccess, services.registryMonitor, { timezone: 'Asia/Kolkata', random: () => 0.5 }, createLogger('silent'), () => at);
  const records = () => [...erp.ecommerceUsers.values()];
  const registryWrites = () => erp.requests.filter((r) => r.method !== 'GET' && r.path.startsWith(`/api/resource/${REGISTRY_DOCTYPE}`));
  const person = (email: string) => ({ name: 'Kavya Rao', email, phone: '+91 98765 43210', password: 'Green-Fields-2026', confirmPassword: 'Green-Fields-2026' });
  const tokenFor = (email: string) =>
    mailer.outbox.filter((m) => m.to === email.trim().toLowerCase()).at(-1)!.text.match(/#token=([A-Za-z0-9_-]{43})/)![1]!;
  const later = () => new Date(Date.now() + 2 * 3600_000); // past any backoff

  beforeAll(async () => {
    // Network guard first, so every client built below (ERPNext, Mongo is not fetch-based) uses it.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!isLoopbackHost(url.hostname)) {
        blocked.push(url.hostname);
        throw new Error(`registry e2e: refused non-local request to ${url.hostname}`);
      }
      return realFetch(input, init);
    }) as typeof fetch;

    mongo = await MongoMemoryServer.create();
    applyMongooseHardening();
    conn = await mongoose.createConnection(mongo.getUri('agrismart-registry-e2e')).asPromise();
    repos = createMongoRepositories(conn);
    await ensureMongoIndexes(conn);
    erp = await startStubErp();
    config = loadConfig(testEnv(erp.url, { ERPNEXT_USER_SYNC: 'true', ERPNEXT_LEAD_SYNC: 'false', APP_PUBLIC_URL: 'http://127.0.0.1:5173' }));
    mailer = new MemoryMailer();
    const logger = createLogger('silent');
    services = buildServices(config, logger, repos, { mailer });
    server = createApp({ config, logger, repos, services, isReady: () => true }).listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  }, 120_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await erp?.close();
    await conn?.close();
    await mongo?.stop();
  });

  it('targets only the local mock; production cannot be reached or written', async () => {
    expect(config.erpnext.baseUrl.hostname).toBe('127.0.0.1');
    expect(config.erpnext.writes.allowed).toBe(true); // to the local mock only
    expect(runtimeWriteBlock(new URL(PRODUCTION))).toMatch(/never write to production/);
    await expect(fetch(PRODUCTION, { method: 'POST', body: '{}' })).rejects.toThrow(/refused non-local request/);
    expect(blocked).toEqual(['asfsl.sanvidhierp.in']);
    expect(await services.registryAccess()).toEqual({ ok: true }); // the mock answers the access check
  });

  it('registration alone sends the verification email but writes nothing to ERPNext', async () => {
    expect((await api('/customer/auth/register', person('farmer@example.com'))).status).toBe(202);
    expect(mailer.outbox.map((m) => m.subject)).toEqual(['Confirm your Agrismart email address']);
    await runJob();
    expect(registryWrites()).toHaveLength(0);
    expect((await repos.customers.registryHealth(new Date())).awaitingEmailVerification).toBe(1);
  });

  it('email verification creates exactly one registry record with the expected fields', async () => {
    expect((await api('/customer/auth/verify-email', { token: tokenFor('farmer@example.com') })).status).toBe(200);
    await runJob();
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({
      name: expect.stringMatching(/^ECU-\d{4}-\d{5}$/),
      naming_series: 'ECU-.YYYY.-.#####',
      customer_name: 'Kavya Rao',
      email: 'farmer@example.com',
      mobile: '+919876543210',
      registration_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      email_verified: 1,
      account_status: 'Active',
      last_login: null,
    });
    expect(registryWrites().map((r) => r.method)).toEqual(['POST']);
  });

  it('repeating the verification changes nothing and creates no duplicate', async () => {
    expect((await api('/customer/auth/verify-email', { token: tokenFor('farmer@example.com') })).status).toBe(400); // single use
    await runJob();
    expect(records()).toHaveLength(1);
    expect(registryWrites()).toHaveLength(1);
  });

  it('a sign-in updates last_login on the same record', async () => {
    expect((await api('/customer/auth/login', { email: 'farmer@example.com', password: 'Green-Fields-2026' })).status).toBe(200);
    await runJob();
    expect(records()).toHaveLength(1);
    expect(records()[0]!.last_login).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(registryWrites().map((r) => r.method)).toEqual(['POST', 'PUT']);
  });

  it('retries after an ERPNext failure without creating a duplicate', async () => {
    await api('/customer/auth/register', person('retry@example.com'));
    erp.override.set(`/api/resource/${REGISTRY_DOCTYPE}`, (rec, res) => {
      if (rec.method === 'GET') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":[]}');
      res.writeHead(503).end(); // ERPNext unavailable for writes
    });
    expect((await api('/customer/auth/verify-email', { token: tokenFor('retry@example.com') })).status).toBe(200); // still verified
    await runJob();
    const health = await repos.customers.registryHealth(new Date());
    expect(health).toMatchObject({ retrying: 1, errorKinds: { upstream: 1 } });
    erp.override.clear();
    await runJob(later());
    expect(records().filter((r) => r.email === 'retry@example.com')).toHaveLength(1);
    expect((await repos.customers.registryHealth(new Date())).retrying).toBe(0);
  });

  it('a lost response after ERPNext accepted the record is adopted on retry, not duplicated', async () => {
    await api('/customer/auth/register', person('lost@example.com'));
    erp.override.set(`/api/resource/${REGISTRY_DOCTYPE}`, (rec, res) => {
      if (rec.method === 'GET') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":[]}');
      const doc = JSON.parse(rec.body) as Record<string, unknown>;
      erp.ecommerceUsers.set('ECU-2026-90001', { ...doc, name: 'ECU-2026-90001' }); // accepted...
      erp.override.clear();
      res.writeHead(502).end(); // ...but the answer is lost
    });
    await api('/customer/auth/verify-email', { token: tokenFor('lost@example.com') });
    await runJob();
    await runJob(later());
    expect(records().filter((r) => r.email === 'lost@example.com').map((r) => r.name)).toEqual(['ECU-2026-90001']);
  });

  it('an existing record with the same email in another case is adopted, not duplicated', async () => {
    erp.ecommerceUsers.set('ECU-2025-00042', { name: 'ECU-2025-00042', email: 'MIXED@Example.com', customer_name: 'Entered by staff', registration_date: '2025-02-01' });
    await api('/customer/auth/register', person('  Mixed@example.COM '));
    await api('/customer/auth/verify-email', { token: tokenFor('mixed@example.com') });
    await runJob();
    const mine = records().filter((r) => String(r.email).toLowerCase() === 'mixed@example.com');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ name: 'ECU-2025-00042', email: 'mixed@example.com', customer_name: 'Kavya Rao', registration_date: '2025-02-01' });
  });

  it('ends with one record per verified customer and nothing sent anywhere but the mock', () => {
    const emails = records().map((r) => String(r.email).toLowerCase());
    expect(new Set(emails).size).toBe(emails.length);
    expect(emails.sort()).toEqual(['farmer@example.com', 'lost@example.com', 'mixed@example.com', 'retry@example.com']);
    expect(blocked).toEqual(['asfsl.sanvidhierp.in']); // only the deliberate probe in the first test
  });
});
