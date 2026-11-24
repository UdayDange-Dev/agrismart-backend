import { resolve } from 'node:path';
import type { ServerResponse } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { todayInTimezone } from '../src/services/pricing.js';
import { ErpNextClient } from '../src/integrations/erpnext/client.js';
import { loadRegistryArtifacts, runRegistrySetup, validateRegistryArtifacts } from '../src/integrations/erpnext/registrySetup.js';
import { hashPassword } from '../src/services/authService.js';
import {
  ACTIVITY_INTERVAL_MS,
  checkRegistryAccess,
  computeUserStats,
  MAX_REGISTRY_ATTEMPTS,
  REGISTRY_DOCTYPE,
  retryDelayMs,
  runRegistryJobOnce,
  syncCustomerToRegistry,
  toRegistryDoc,
  windowStart,
  type UserRegistryGateway,
} from '../src/services/userRegistry.js';
import { ALLOWED_ORIGIN, buildTestApp, CUSTOMER_PASSWORD, customerSession, startStubErp, TEST_API_KEY, TEST_API_SECRET, testEnv, type StubErp } from './helpers.js';

let erp: StubErp;
beforeAll(async () => {
  erp = await startStubErp();
});
afterAll(() => erp.close());
beforeEach(() => {
  erp.override.clear();
  erp.requests.length = 0;
  erp.ecommerceUsers.clear();
});

const TZ = 'Asia/Kolkata';
const USERS_PATH = `/api/resource/${REGISTRY_DOCTYPE}`;
const writes = () => erp.requests.filter((r) => r.method !== 'GET' && r.path.startsWith(USERS_PATH));
const respond = (res: ServerResponse, status: number, body = '{}', headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(body);
};
/** Makes every request for E-commerce User fail with `status` (ERPNext outage, permissions...). */
const failRegistry = (status: number, headers: Record<string, string> = {}) =>
  erp.override.set(USERS_PATH, (_rec, res) => respond(res, status, '{"exc_type":"Error"}', headers));

/** The ERPNext record linked to a website customer (by the name stored after the first sync). */
async function recordOf(repos: ReturnType<typeof buildTestApp>['repos'], id: string) {
  const name = (await repos.customers.findById(id))!.registrySync.erpName;
  return name ? erp.ecommerceUsers.get(name) : undefined;
}

function setup() {
  const ctx = buildTestApp(erp.url, { env: { ERPNEXT_USER_SYNC: 'true' } });
  const { repos, services, logger } = ctx;
  const sync = (id: string, gateway: UserRegistryGateway = services.userRegistry, now?: () => Date) =>
    syncCustomerToRegistry(repos.customers, gateway, id, { timezone: TZ, random: () => 0.5 }, logger, now);
  const register = async (email = 'farmer@example.com') => {
    const res = await request(ctx.app)
      .post('/api/customer/auth/register')
      .set('Origin', ALLOWED_ORIGIN)
      .send({ name: 'Kavya Rao', email, phone: '+91 98765 43210', password: CUSTOMER_PASSWORD, confirmPassword: CUSTOMER_PASSWORD });
    expect(res.status).toBe(202);
    return (await repos.customers.findByEmail(email))!;
  };
  /** Registers and confirms the email through the real API (the link from the email). */
  const registerVerified = async (email = 'farmer@example.com') => {
    const c = await register(email);
    const token = ctx.mailer.outbox.filter((m) => m.to === c.email).at(-1)!.text.match(/#token=([A-Za-z0-9_-]{43})/)![1]!;
    expect((await request(ctx.app).post('/api/customer/auth/verify-email').set('Origin', ALLOWED_ORIGIN).send({ token })).status).toBe(200);
    return (await repos.customers.findById(c.id))!;
  };
  const state = async (id: string) => (await repos.customers.findById(id))!.registrySync;
  const runJob = () => runRegistryJobOnce(repos.customers, services.userRegistry, services.registryAccess, services.registryMonitor, { timezone: TZ, random: () => 0.5 }, logger);
  return { ...ctx, sync, register, registerVerified, state, runJob };
}

describe('registration and email verification policy', () => {
  it('does not send unverified accounts to ERPNext; confirming the email queues the first sync', async () => {
    const { register, sync, state, repos, app } = setup();
    const c = await register();
    expect(await repos.customers.findDueForRegistrySync(new Date(Date.now() + 86400_000), 10)).toEqual([]);
    expect(await sync(c.id)).toEqual({ status: 'locked' }); // not claimable while unverified
    expect((await repos.customers.registryHealth(new Date())).awaitingEmailVerification).toBe(1);

    // A failed verification (bad or expired link) changes nothing.
    expect((await request(app).post('/api/customer/auth/verify-email').set('Origin', ALLOWED_ORIGIN).send({ token: 'A'.repeat(43) })).status).toBe(400);
    expect(await sync(c.id)).toEqual({ status: 'locked' });
    expect(erp.requests.filter((r) => r.path.startsWith(USERS_PATH))).toHaveLength(0);

    await repos.customers.markEmailVerified(c.id, new Date());
    const queued = await state(c.id);
    expect(queued.version).toBeGreaterThan(queued.syncedVersion);
    expect((await repos.customers.findDueForRegistrySync(new Date(), 10)).map((x) => x.id)).toEqual([c.id]);
    expect(await sync(c.id)).toMatchObject({ status: 'synced', result: 'created' });
    expect((await recordOf(repos, c.id))).toMatchObject({ email_verified: 1 });
  });

  it('repeated verification events do not create new versions; later profile changes are synced', async () => {
    const { registerVerified, sync, state, repos, app } = setup();
    const c = await registerVerified();
    expect(await sync(c.id)).toMatchObject({ status: 'synced' });
    const synced = await state(c.id);
    await repos.customers.markEmailVerified(c.id, new Date()); // e.g. a second click
    expect(await state(c.id)).toMatchObject({ version: synced.version, syncedVersion: synced.version });

    const agent = request.agent(app);
    const login = await agent.post('/api/customer/auth/login').set('Origin', ALLOWED_ORIGIN).send({ email: c.email, password: CUSTOMER_PASSWORD });
    const patch = await agent.patch('/api/customer/account').set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', login.body.csrfToken).send({ name: 'Kavya S Rao', phone: '91234 56789' });
    expect(patch.status).toBe(200);
    expect(patch.body.customer.phone).toBe('+919123456789'); // normalised to E.164
    expect(await sync(c.id)).toMatchObject({ status: 'synced', result: 'updated' });
    expect((await recordOf(repos, c.id))).toMatchObject({ customer_name: 'Kavya S Rao', mobile: '+919123456789' });
  });

  it('an expired verification link verifies nothing and queues no sync', async () => {
    const { register, repos, app, mailer, sync } = setup();
    const c = await register();
    const token = mailer.outbox.at(-1)!.text.match(/#token=([A-Za-z0-9_-]{43})/)![1]!;
    for (const t of repos.customerTokens.rows) t.expiresAt = new Date(Date.now() - 1000);
    const res = await request(app).post('/api/customer/auth/verify-email').set('Origin', ALLOWED_ORIGIN).send({ token });
    expect(res.status).toBe(400);
    expect((await repos.customers.findById(c.id))!.emailVerified).toBe(false);
    expect(await sync(c.id)).toEqual({ status: 'locked' });
    expect(erp.requests.filter((r) => r.path.startsWith(USERS_PATH))).toHaveLength(0);
  });

  it('verification succeeds while ERPNext is down; the job records the failure, then syncs once without duplicates', async () => {
    const { registerVerified, repos, state, runJob } = setup();
    erp.override.set(USERS_PATH, (rec, res) => {
      // Reads (access check, lookup) work; writes fail as during an ERPNext outage.
      if (rec.method === 'GET') return respond(res, 200, '{"data":[]}');
      respond(res, 503, '{}');
    });
    const c = await registerVerified(); // the verify-email request itself answered 200
    expect((await repos.customers.findById(c.id))!.emailVerified).toBe(true);
    await runJob();
    expect(await state(c.id)).toMatchObject({ attempts: 1, lastErrorKind: 'upstream', failure: null, erpName: null });
    expect((await repos.customers.registryHealth(new Date())).retrying).toBe(1);

    erp.override.clear(); // ERPNext is back; run when the backoff has passed
    await repos.customers.retryFailedRegistrySync(new Date(), 'failed'); // no-op: it is retrying, not failed
    repos.customers.rows.get(c.id)!.registrySync.nextAttemptAt = new Date(Date.now() - 1000);
    await runJob();
    expect(erp.ecommerceUsers.size).toBe(1);
    expect(await state(c.id)).toMatchObject({ attempts: 0, lastErrorKind: null, erpName: expect.stringMatching(/^ECU-/) });
    expect((await recordOf(repos, c.id))).toMatchObject({ email_verified: 1, account_status: 'Active' });
  });

  it('never lets a client set verification, status or sync fields', async () => {
    const { app, repos } = setup();
    const base = { name: 'Kavya Rao', email: 'x@example.com', phone: '+91 98765 43210', password: CUSTOMER_PASSWORD, confirmPassword: CUSTOMER_PASSWORD };
    for (const extra of [{ emailVerified: true }, { email_verified: 1 }, { accountStatus: 'active' }, { website_user_id: 'abc' }, { registrySync: { syncedVersion: 99 } }]) {
      expect((await request(app).post('/api/customer/auth/register').set('Origin', ALLOWED_ORIGIN).send({ ...base, ...extra })).status).toBe(400);
    }
    const s = await customerSession(app, repos);
    for (const extra of [{ emailVerified: false }, { email_verified: 1 }, { accountStatus: 'suspended' }, { website_user_id: 'x' }, { registrySync: {} }, { email: 'y@example.com' }]) {
      expect((await s.patch('/api/customer/account', { name: 'Asha P', ...extra })).status).toBe(400);
    }
  });
});

describe('what is sent', () => {
  it('creates one record per verified account with exactly the DocType fields, named by the ERPNext series', async () => {
    const { registerVerified, sync, repos, state } = setup();
    const c = await registerVerified('  Farmer@Example.COM ');
    const r = await sync(c.id);
    expect(r).toMatchObject({ status: 'synced', result: 'created', name: expect.stringMatching(/^ECU-\d{4}-\d{5}$/) });
    const name = (r as { name: string }).name;
    expect((await state(c.id)).erpName).toBe(name); // linked for later updates
    const post = writes().find((w) => w.method === 'POST')!;
    const body = JSON.parse(post.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ['account_status', 'customer_name', 'email', 'email_verified', 'last_activity', 'last_login', 'mobile', 'naming_series', 'registration_date'].sort(),
    );
    const stored = (await repos.customers.findById(c.id))!;
    expect(body).toMatchObject({
      naming_series: 'ECU-.YYYY.-.#####',
      customer_name: 'Kavya Rao',
      email: 'farmer@example.com',
      mobile: '+919876543210',
      registration_date: todayInTimezone(TZ, stored.createdAt), // the original registration DATE
      email_verified: 1,
      account_status: 'Active',
      last_login: null, // registration and verification are not logins
    });
    expect(erp.ecommerceUsers.size).toBe(1);
    const sent = writes().map((w) => w.body).join('\n');
    expect(sent).not.toContain(stored.passwordHash);
    expect(sent).not.toMatch(/password|hash|token|session|cookie|address|website_user_id/i);
    expect(post.headers.authorization).toBe(`token ${TEST_API_KEY}:${TEST_API_SECRET}`);
  });

  it('builds the document from an explicit field list', async () => {
    const { repos } = buildTestApp(erp.url);
    const c = await repos.customers.create({ email: ' A@Example.com ', name: 'Asha', phone: '+919876543210', passwordHash: '$2b$12$secret' });
    expect(c.email).toBe('a@example.com');
    const doc = toRegistryDoc({ ...c, lastLoginAt: new Date('2026-10-01T04:30:00Z'), createdAt: new Date('2026-09-30T18:30:00Z') }, TZ);
    expect(doc).toEqual({
      customer_name: 'Asha',
      email: 'a@example.com',
      mobile: '+919876543210',
      registration_date: '2026-10-01', // 00:00 IST on 1 Oct
      email_verified: 0,
      account_status: 'Active',
      last_login: '2026-10-01 10:00:00',
      last_activity: null,
    });
  });

  it('maps account statuses to exactly Active, Inactive and Suspended', async () => {
    const { repos } = buildTestApp(erp.url);
    const c = await repos.customers.create({ email: 's@example.com', name: 'S', phone: '+919876543210', passwordHash: 'x' });
    const labels = (['active', 'inactive', 'suspended'] as const).map((accountStatus) => toRegistryDoc({ ...c, accountStatus }, TZ).account_status);
    expect(labels).toEqual(['Active', 'Inactive', 'Suspended']);
  });
});

describe('retry lifecycle', () => {
  it('keeps the backoff, attempts and error while customers stay active during an outage', async () => {
    const { registerVerified, sync, state, repos } = setup();
    const c = await registerVerified();
    erp.override.set(USERS_PATH, () => new Promise(() => undefined)); // hang -> client timeout
    expect(await sync(c.id)).toMatchObject({ status: 'retry', kind: 'timeout', attempts: 1 });
    const before = await state(c.id);
    for (let i = 0; i < 3; i++) {
      await repos.customers.recordLogin(c.id, new Date());
      await repos.customers.recordActivity(c.id, new Date(Date.now() + (i + 1) * ACTIVITY_INTERVAL_MS * 2), ACTIVITY_INTERVAL_MS);
    }
    const after = await state(c.id);
    expect(after.version).toBeGreaterThan(before.version); // the changes are recorded...
    expect(after).toMatchObject({ attempts: 1, lastErrorKind: 'timeout', failure: null, nextAttemptAt: before.nextAttemptAt, pendingSince: before.pendingSince });
    expect(await repos.customers.findDueForRegistrySync(new Date(), 10)).toEqual([]); // ...but not retried early
  });

  it('backs off exponentially with jitter, honours Retry-After, and stops at the attempt limit', async () => {
    expect([1, 2, 3, 4].map((a) => retryDelayMs(a, () => 0))).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect([1, 2, 3, 4].map((a) => retryDelayMs(a, () => 1))).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(retryDelayMs(30, () => 1)).toBe(6 * 3600_000); // capped
    expect(retryDelayMs(1, () => 0, 7_200_000)).toBe(7_200_000);

    const { registerVerified, sync, state, repos } = setup();
    const c = await registerVerified();
    failRegistry(503);
    const delays: number[] = [];
    for (let i = 1; i < MAX_REGISTRY_ATTEMPTS; i++) {
      const at = Date.now();
      const r = await sync(c.id);
      expect(r).toMatchObject({ status: 'retry', kind: 'upstream', attempts: i });
      delays.push((r as { nextAttemptAt: Date }).nextAttemptAt.getTime() - at);
    }
    for (let i = 1; i < delays.length; i++) expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    expect(await sync(c.id)).toEqual({ status: 'failed', kind: 'upstream', failure: 'exhausted' });
    expect(await state(c.id)).toMatchObject({ attempts: MAX_REGISTRY_ATTEMPTS, failure: 'exhausted', nextAttemptAt: null });
    expect((await repos.customers.registryHealth(new Date())).failedExhausted).toBe(1);

    erp.override.clear();
    const c2 = await registerVerified('second@example.com');
    failRegistry(429, { 'Retry-After': '7200' });
    const r = await sync(c2.id);
    expect(r).toMatchObject({ status: 'retry', kind: 'rate_limited' });
    expect((r as { nextAttemptAt: Date }).nextAttemptAt.getTime()).toBeGreaterThanOrEqual(Date.now() + 7_190_000);
  });

  it('recovers after a transient failure and clears the error', async () => {
    const { registerVerified, sync, state } = setup();
    const c = await registerVerified();
    failRegistry(502);
    expect(await sync(c.id)).toMatchObject({ status: 'retry' });
    erp.override.clear();
    expect(await sync(c.id)).toMatchObject({ status: 'synced', result: 'created' });
    expect(await state(c.id)).toMatchObject({ attempts: 0, lastErrorKind: null, failure: null, pendingSince: null });
  });

  it('keeps a permanent failure visible through later changes until an operator retries it', async () => {
    const { registerVerified, sync, state, repos } = setup();
    const c = await registerVerified();
    failRegistry(417); // ERPNext validation error
    expect(await sync(c.id)).toEqual({ status: 'failed', kind: 'validation', failure: 'permanent' });
    await repos.customers.recordLogin(c.id, new Date()); // a new change does NOT clear it
    expect(await state(c.id)).toMatchObject({ failure: 'permanent', lastErrorKind: 'validation' });
    expect(await repos.customers.findDueForRegistrySync(new Date(Date.now() + 86400_000), 10)).toEqual([]);
    const health = await repos.customers.registryHealth(new Date());
    expect(health).toMatchObject({ failedPermanent: 1, pending: 0, errorKinds: { validation: 1 } });
    expect(await repos.customers.listRegistryFailures(10)).toMatchObject([{ customerId: c.id, failure: 'permanent', lastErrorKind: 'validation' }]);

    // After fixing the cause, an operator retry re-queues it and it syncs with the latest data.
    erp.override.clear();
    expect(await repos.customers.retryFailedRegistrySync(new Date(), 'exhausted', c.id)).toBe(0); // wrong scope
    expect(await repos.customers.retryFailedRegistrySync(new Date(), 'permanent', c.id)).toBe(1);
    expect(await sync(c.id)).toMatchObject({ status: 'synced' });
    expect((await recordOf(repos, c.id))!.last_login).not.toBeNull();
  });

  it('lets only one of several concurrent workers sync a customer', async () => {
    const { registerVerified, sync } = setup();
    const c = await registerVerified();
    const results = await Promise.all([sync(c.id), sync(c.id), sync(c.id)]);
    expect(results.filter((r) => r.status === 'synced')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'locked')).toHaveLength(2);
    expect(writes().filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('keeps a newer change made during an in-flight sync and sends it next', async () => {
    const { registerVerified, sync, state, repos, services } = setup();
    const c = await registerVerified();
    const login = new Date(Date.now() + 60_000);
    const slow: UserRegistryGateway = {
      async upsert(doc, knownName) {
        await repos.customers.recordLogin(c.id, login); // the customer signs in mid-sync
        return services.userRegistry.upsert(doc, knownName);
      },
    };
    expect(await sync(c.id, slow)).toMatchObject({ status: 'synced' });
    const s = await state(c.id);
    expect(s.version).toBeGreaterThan(s.syncedVersion); // still pending
    expect((await recordOf(repos, c.id))!.last_login).toBeNull(); // the older snapshot
    expect(await sync(c.id)).toMatchObject({ status: 'synced', result: 'updated' });
    expect((await recordOf(repos, c.id))!.last_login).not.toBeNull();
    expect((await state(c.id)).version).toBe((await state(c.id)).syncedVersion);
  });

  it('a worker whose lock expired cannot record success over a newer worker; the data is re-queued', async () => {
    const { registerVerified, repos, state } = setup();
    const c = await registerVerified();
    const t0 = new Date();
    const first = await repos.customers.claimRegistrySync(c.id, t0, 1000);
    const second = await repos.customers.claimRegistrySync(c.id, new Date(t0.getTime() + 5000), 1000); // lock expired
    expect(second).not.toBeNull();
    expect(await repos.customers.completeRegistrySync(c.id, second!.registrySync.lockToken!, second!.registrySync.version, new Date(), 'ECU-TEST-00001')).toBe(true);
    const v = (await state(c.id)).version;
    expect(await repos.customers.completeRegistrySync(c.id, first!.registrySync.lockToken!, first!.registrySync.version, new Date(), 'ECU-TEST-00001')).toBe(false);
    const s = await state(c.id);
    expect(s.syncedVersion).toBe(v); // never moved backwards
    expect(s.version).toBeGreaterThan(s.syncedVersion); // re-queued
  });

  it('timeouts and lost responses after ERPNext accepted the record never duplicate it', async () => {
    const { registerVerified, sync, state } = setup();
    const c = await registerVerified();
    erp.override.set(USERS_PATH, (rec, res) => {
      if (rec.method !== 'POST') return respond(res, 200, '{"data":[]}'); // lookup by email: nothing yet
      const doc = JSON.parse(rec.body) as Record<string, unknown>;
      erp.ecommerceUsers.set('ECU-2026-90001', { ...doc, name: 'ECU-2026-90001' }); // accepted...
      erp.override.clear(); // ...but the response never arrives
    });
    expect(await sync(c.id)).toMatchObject({ status: 'retry', kind: 'timeout' });
    expect((await state(c.id)).erpName).toBeNull();
    // The retry finds the record by email, adopts and updates it.
    expect(await sync(c.id)).toMatchObject({ status: 'synced', result: 'updated', name: 'ECU-2026-90001' });
    expect(erp.ecommerceUsers.size).toBe(1);
    expect(await state(c.id)).toMatchObject({ attempts: 0, erpName: 'ECU-2026-90001' });
  });

  it('adopts an existing record whose email differs only in case or spaces, keeping its registration date', async () => {
    const { registerVerified, sync } = setup();
    erp.ecommerceUsers.set('ECU-2025-00007', { name: 'ECU-2025-00007', email: 'FARMER@EXAMPLE.COM', customer_name: 'Old', registration_date: '2025-01-01' });
    const c = await registerVerified(' Farmer@example.com ');
    expect(await sync(c.id)).toMatchObject({ status: 'synced', result: 'updated', name: 'ECU-2025-00007' });
    expect(erp.ecommerceUsers.size).toBe(1);
    expect(erp.ecommerceUsers.get('ECU-2025-00007')).toMatchObject({ email: 'farmer@example.com', customer_name: 'Kavya Rao', registration_date: '2025-01-01' });
    expect(writes().filter((w) => w.method === 'POST')).toHaveLength(0);
  });

  it('several ERPNext records with the same email are a permanent duplicate_email failure; none is touched', async () => {
    const { registerVerified, sync, state } = setup();
    for (const n of ['ECU-2025-00001', 'ECU-2025-00002']) erp.ecommerceUsers.set(n, { name: n, email: 'shared@example.com', customer_name: 'Other' });
    const c = await registerVerified('shared@example.com');
    expect(await sync(c.id)).toEqual({ status: 'failed', kind: 'duplicate_email', failure: 'permanent' });
    expect(writes()).toHaveLength(0);
    expect([...erp.ecommerceUsers.values()].every((u) => u.customer_name === 'Other')).toBe(true);
    expect(await state(c.id)).toMatchObject({ failure: 'permanent', erpName: null });
  });

  it('updates the linked record by name: email changes do not create a second record', async () => {
    const { registerVerified, sync, repos, state } = setup();
    const c = await registerVerified('old@example.com');
    const { name } = (await sync(c.id)) as { name: string };
    await repos.customers.changeEmail(c.id, 'New@Example.com', new Date());
    expect(await sync(c.id)).toMatchObject({ status: 'synced', result: 'updated', name });
    expect(erp.ecommerceUsers.size).toBe(1);
    expect(erp.ecommerceUsers.get(name)!.email).toBe('new@example.com');
    expect((await state(c.id)).erpName).toBe(name);
  });

  it('updates never send naming_series or registration_date, so ERPNext keeps the originals', async () => {
    const { registerVerified, sync, repos } = setup();
    const c = await registerVerified();
    const { name } = (await sync(c.id)) as { name: string };
    erp.ecommerceUsers.get(name)!.registration_date = '2024-12-31'; // e.g. corrected by staff
    await repos.customers.recordLogin(c.id, new Date());
    expect(await sync(c.id)).toMatchObject({ status: 'synced', result: 'updated' });
    const put = JSON.parse(writes().filter((w) => w.method === 'PUT').at(-1)!.body) as Record<string, unknown>;
    expect(put).not.toHaveProperty('registration_date');
    expect(put).not.toHaveProperty('naming_series');
    expect(erp.ecommerceUsers.get(name)).toMatchObject({ registration_date: '2024-12-31', last_login: expect.any(String) });
  });

  it('re-creates a linked record that was deleted in ERPNext and re-links it', async () => {
    const { registerVerified, sync, repos, state } = setup();
    const c = await registerVerified();
    const first = ((await sync(c.id)) as { name: string }).name;
    erp.ecommerceUsers.delete(first);
    await repos.customers.recordLogin(c.id, new Date());
    const again = await sync(c.id);
    expect(again).toMatchObject({ status: 'synced', result: 'created' });
    const second = (again as { name: string }).name;
    expect(second).not.toBe(first);
    expect(erp.ecommerceUsers.size).toBe(1);
    expect((await state(c.id)).erpName).toBe(second);
  });
});

describe('configuration problems pause the integration (not the customers)', () => {
  it('a missing DocType is detected read-only and pauses the job without failing anyone', async () => {
    const { registerVerified, state, runJob, services } = setup();
    const c = await registerVerified();
    failRegistry(404);
    expect(await services.registryAccess()).toEqual({ ok: false, problem: 'doctype_missing' });
    await runJob();
    expect(services.registryMonitor.snapshot()).toMatchObject({ state: 'blocked', problem: 'doctype_missing' });
    expect(await state(c.id)).toMatchObject({ attempts: 0, failure: null, lastErrorKind: null });
    expect(erp.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);

    erp.override.clear(); // the DocType is deployed
    await runJob();
    expect(services.registryMonitor.snapshot()).toMatchObject({ state: 'ready', problem: null });
    expect(erp.ecommerceUsers.size).toBe(1);
  });

  it('permission and credential errors during a sync pause the job and leave the customer untouched', async () => {
    const { registerVerified, sync, state } = setup();
    const c = await registerVerified();
    failRegistry(403);
    expect(await sync(c.id)).toEqual({ status: 'paused', problem: 'permission' });
    failRegistry(401);
    expect(await sync(c.id)).toEqual({ status: 'paused', problem: 'auth' });
    expect(await state(c.id)).toMatchObject({ attempts: 0, failure: null, lockToken: null, lockedUntil: null });
  });

  it('distinguishes missing DocType, credentials, permissions and outages in the access check', async () => {
    const client = new ErpNextClient({ baseUrl: new URL(erp.url), apiKey: TEST_API_KEY, apiSecret: TEST_API_SECRET, timeoutMs: 500 });
    for (const [status, problem] of [[404, 'doctype_missing'], [401, 'auth'], [403, 'permission'], [502, 'unavailable']] as const) {
      failRegistry(status);
      expect(await checkRegistryAccess(client)).toEqual({ ok: false, problem });
    }
    erp.override.clear();
    expect(await checkRegistryAccess(client)).toEqual({ ok: true });
  });
});

describe('health reporting and operator retry', () => {
  it('reports aggregate queue health to staff only, without personal data', async () => {
    const { app, repos, registerVerified, register, sync } = setup();
    const ok = await registerVerified('ok@example.com');
    const bad = await registerVerified('bad@example.com');
    await register('unverified@example.com');
    await sync(ok.id);
    failRegistry(417);
    await sync(bad.id);
    erp.override.clear();

    await repos.users.create({ email: 'staff@example.com', passwordHash: await hashPassword('Correct-Horse-42'), role: 'staff' });
    await repos.users.create({ email: 'admin@example.com', passwordHash: await hashPassword('Correct-Horse-42'), role: 'admin' });
    const login = async (email: string) => {
      const agent = request.agent(app);
      const res = await agent.post('/api/auth/login').set('Origin', ALLOWED_ORIGIN).send({ email, password: 'Correct-Horse-42' });
      return { agent, csrf: res.body.csrfToken as string };
    };
    const staff = await login('staff@example.com');
    const health = await staff.agent.get('/api/admin/customers/registry-health').set('Origin', ALLOWED_ORIGIN);
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      enabled: true,
      queue: { pending: 0, failedPermanent: 1, failedExhausted: 0, awaitingEmailVerification: 1, errorKinds: { validation: 1 } },
    });
    expect(health.body.queue.lastSuccessAt).toEqual(expect.any(String));
    expect(JSON.stringify(health.body)).not.toMatch(/@example\.com|\+91|Kavya/);

    // Customers and visitors cannot see it.
    const customer = await customerSession(app, repos);
    expect((await customer.agent.get('/api/admin/customers/registry-health')).status).toBe(401);
    expect((await request(app).get('/api/admin/customers/registry-health')).status).toBe(401);

    // Retry is admin-only and CSRF-protected.
    const retry = (who: typeof staff, body: object) =>
      who.agent.post('/api/admin/customers/registry-sync/retry').set('Origin', ALLOWED_ORIGIN).set('X-CSRF-Token', who.csrf).send(body);
    expect((await retry(staff, { scope: 'permanent' })).status).toBe(403);
    const admin = await login('admin@example.com');
    expect((await admin.agent.post('/api/admin/customers/registry-sync/retry').set('Origin', ALLOWED_ORIGIN).send({})).status).toBe(403);
    expect((await retry(admin, { scope: 'everything' })).status).toBe(400);
    expect((await retry(admin, { scope: 'permanent' })).body).toEqual({ requeued: 1 });
    // The failed customer is pending again, next to the (verified, not yet synced) session customer.
    expect(await repos.customers.registryHealth(new Date())).toMatchObject({ pending: 2, failedPermanent: 0 });
    // Public customer APIs expose no sync details.
    expect(JSON.stringify((await customer.agent.get('/api/customer/account')).body)).not.toMatch(/registry|lockToken|syncedVersion/);
  });
});

describe('activity, login and account status', () => {
  it('sign-in and meaningful actions update the registry; browsing does not', async () => {
    const { registerVerified, sync, app, repos } = setup();
    const c = await registerVerified();
    const agent = request.agent(app);
    expect((await agent.post('/api/customer/auth/login').set('Origin', ALLOWED_ORIGIN).send({ email: c.email, password: CUSTOMER_PASSWORD })).status).toBe(200);
    const afterLogin = (await repos.customers.findById(c.id))!;
    expect(afterLogin.lastLoginAt).not.toBeNull();
    for (const path of ['/api/products', '/api/customer/account', '/api/customer/orders', '/api/customer/auth/session']) await agent.get(path);
    expect((await repos.customers.findById(c.id))!.registrySync.version).toBe(afterLogin.registrySync.version);
    expect(await sync(c.id)).toMatchObject({ status: 'synced' });
    const doc = (await recordOf(repos, c.id))!;
    expect(doc.last_login).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(doc.last_activity).toBe(doc.last_login);
  });

  it('records orders and inquiries as activity, at most once per interval', async () => {
    const { app, repos } = setup();
    const s = await customerSession(app, repos);
    repos.customers.rows.get(s.id)!.lastActivityAt = new Date(Date.now() - 3600_000);
    const before = (await repos.customers.findById(s.id))!.registrySync.version;
    expect((await s.post('/api/inquiries', { name: 'Asha Patil', message: 'Need 20 bags of compost please.' })).status).toBe(202);
    const afterInquiry = (await repos.customers.findById(s.id))!;
    expect(afterInquiry.registrySync.version).toBe(before + 1);
    await s.post('/api/orders', {
      customer: { name: 'Asha Patil', phone: '9876543210' },
      shippingAddress: { line1: '12 Farm Road', city: 'Pune', state: 'Maharashtra', postalCode: '411001' },
      items: [{ itemCode: 'SEED-001', qty: 1 }],
      acceptTerms: true,
    });
    expect((await repos.customers.findById(s.id))!.registrySync.version).toBe(afterInquiry.registrySync.version);
  });

  it('suspension ends sessions, blocks sign-in and reaches ERPNext', async () => {
    const { app, repos, services, sync } = setup();
    const s = await customerSession(app, repos, { email: 'suspend@example.com' });
    await services.customers.setAccountStatus('suspend@example.com', 'suspended');
    expect((await s.agent.get('/api/customer/account')).status).toBe(401);
    const login = await request(app).post('/api/customer/auth/login').set('Origin', ALLOWED_ORIGIN).send({ email: 'suspend@example.com', password: CUSTOMER_PASSWORD });
    expect(login.body.error.code).toBe('account_disabled');
    expect(await sync(s.id)).toMatchObject({ status: 'synced' });
    expect((await recordOf(repos, s.id))!.account_status).toBe('Suspended');
  });

  it('writes nothing to ERPNext while ERPNEXT_USER_SYNC is off (the default)', async () => {
    expect(loadConfig(testEnv(erp.url)).erpnext.userSync).toBe(false);
    const { app } = buildTestApp(erp.url);
    await request(app)
      .post('/api/customer/auth/register')
      .set('Origin', ALLOWED_ORIGIN)
      .send({ name: 'Kavya Rao', email: 'off@example.com', phone: '+91 98765 43210', password: CUSTOMER_PASSWORD, confirmPassword: CUSTOMER_PASSWORD });
    expect(writes()).toHaveLength(0);
  });
});

describe('reporting accuracy', () => {
  const NOW = new Date('2026-10-27T06:30:00Z'); // 12:00 IST

  it('uses calendar-day windows in the site timezone, today included', () => {
    expect(windowStart(7, TZ, NOW).toISOString()).toBe('2026-10-20T18:30:00.000Z');
    expect(windowStart(30, TZ, NOW).toISOString()).toBe('2026-09-27T18:30:00.000Z');
    expect(windowStart(1, TZ, new Date('2026-10-26T18:31:00Z')).toISOString()).toBe('2026-10-26T18:30:00.000Z');
  });

  it('counts registrations, statuses, verification and distinct active users exactly', async () => {
    const { repos } = buildTestApp(erp.url);
    const at = (iso: string) => new Date(iso);
    const make = async (n: number, over: { createdAt: string; verified?: boolean; status?: 'active' | 'inactive' | 'suspended'; activity?: string | null }) => {
      const c = await repos.customers.create({ email: `u${n}@example.com`, name: `User ${n}`, phone: '+919876543210', passwordHash: 'x' });
      Object.assign(repos.customers.rows.get(c.id)!, {
        createdAt: at(over.createdAt),
        emailVerified: over.verified ?? true,
        accountStatus: over.status ?? 'active',
        lastActivityAt: over.activity ? at(over.activity) : null,
      });
    };
    await make(1, { createdAt: '2026-10-20T18:30:00Z', activity: '2026-10-27T05:00:00Z' });
    await make(2, { createdAt: '2026-10-20T18:29:59Z', activity: '2026-09-27T18:30:00Z' });
    await make(3, { createdAt: '2026-09-27T18:30:00Z', verified: false, activity: '2026-09-27T18:29:59Z' });
    await make(4, { createdAt: '2025-01-01T00:00:00Z', status: 'suspended', activity: '2026-10-25T10:00:00Z' });
    await make(5, { createdAt: '2025-01-01T00:00:00Z', status: 'inactive', activity: null });
    await make(6, { createdAt: '2025-01-01T00:00:00Z', verified: false, activity: null });
    expect(await computeUserStats(repos.customers, TZ, NOW)).toEqual({
      totalRegistered: 6,
      activeAccounts: 4,
      inactiveAccounts: 1,
      suspendedAccounts: 1,
      emailVerified: 4,
      newLast7Days: 1,
      newLast30Days: 3,
      activeUsersLast30Days: 3,
      windows: { last7DaysFrom: '2026-10-21 00:00:00', last30DaysFrom: '2026-09-28 00:00:00', timezone: TZ },
    });
  });
});

describe('ERPNext definitions and setup script', () => {
  const dir = resolve(import.meta.dirname, '../erpnext');

  it('defines the DocType safely and matches the website report windows', async () => {
    const a = loadRegistryArtifacts(dir);
    const fields = (a.doctype.fields as { fieldname: string }[]).map((f) => f.fieldname);
    expect(fields.join(',')).not.toMatch(/pass|hash|token|session/i);
    const card = (name: string) => a.numberCards.find((c) => c.name === name)!;
    expect(card('E-commerce Users: New (7 days)').dynamic_filters_json).toContain('add_days(frappe.datetime.now_date(), -6)');
    expect(card('E-commerce Users: Active Users (30 days)').dynamic_filters_json).toMatch(/"last_activity",">=".*-29\)/);
    const { repos } = buildTestApp(erp.url);
    const sample = await repos.customers.create({ email: 'a@example.com', name: 'A', phone: '+919876543210', passwordHash: 'x' });
    for (const k of Object.keys(toRegistryDoc(sample, TZ))) expect(fields).toContain(k);
  });

  it('rejects definitions that would store credentials or over-grant', () => {
    const a = loadRegistryArtifacts(dir);
    const withField = structuredClone(a);
    (withField.doctype.fields as unknown[]).push({ fieldname: 'password_hash', fieldtype: 'Data' });
    expect(() => validateRegistryArtifacts(withField)).toThrow(/password_hash/);
    const admin = structuredClone(a);
    (admin.doctype.permissions as unknown[]).push({ role: 'System Manager', read: 1 });
    expect(() => validateRegistryArtifacts(admin)).toThrow(/System Manager/);
  });

  it('check mode is read-only; apply creates only missing items and never updates or deletes', async () => {
    const a = loadRegistryArtifacts(dir);
    const existing = new Set(['Role/E-commerce Integration']);
    const created: string[] = [];
    for (const doctype of ['Role', 'DocType', 'Number Card', 'Workspace']) {
      erp.override.set(`/api/resource/${doctype}`, (rec, res) => {
        const name = decodeURIComponent(rec.path.slice(`/api/resource/${doctype}/`.length));
        if (rec.method === 'GET') return respond(res, existing.has(`${doctype}/${name}`) ? 200 : 404, JSON.stringify({ data: { name } }));
        if (rec.method !== 'POST') return respond(res, 405);
        const doc = JSON.parse(rec.body) as Record<string, unknown>;
        const docName = String(doc.name ?? doc.role_name);
        existing.add(`${doctype}/${docName}`);
        created.push(`${doctype}/${docName}`);
        respond(res, 200, JSON.stringify({ data: { name: docName } }));
      });
    }
    const opts = { baseUrl: new URL(erp.url), apiKey: TEST_API_KEY, apiSecret: TEST_API_SECRET, timeoutMs: 1000 };
    const check = await runRegistrySetup(new ErpNextClient(opts), a, { apply: false });
    expect(check.filter((s) => s.status === 'missing')).toHaveLength(check.length - 1);
    expect(erp.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
    const applied = await runRegistrySetup(new ErpNextClient({ ...opts, writes: { allowed: true, reason: 'local stub' } }), a, { apply: true });
    expect(created[1]).toBe(`DocType/${REGISTRY_DOCTYPE}`);
    expect(created).toHaveLength(applied.length - 1);
    expect(erp.requests.filter((r) => r.method === 'PUT' || r.method === 'DELETE')).toHaveLength(0);
  });
});
