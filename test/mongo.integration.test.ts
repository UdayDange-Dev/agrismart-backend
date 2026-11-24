import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServices, createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { applyMongooseHardening } from '../src/db/mongo.js';
import { createLogger } from '../src/lib/logger.js';
import { createMongoRepositories, ensureMongoIndexes } from '../src/repositories/mongo/index.js';
import { DuplicateKeyError, type Repositories } from '../src/repositories/types.js';
import { hashPassword } from '../src/services/authService.js';
import { ALLOWED_ORIGIN, customerSession, startStubErp, testEnv, type StubErp } from './helpers.js';

/**
 * Runs the real Mongoose repositories against a throwaway local mongod
 * (mongodb-memory-server). Never touches any shared or production database.
 */
let mongo: MongoMemoryServer;
let conn: mongoose.Connection;
let repos: Repositories;
let erp: StubErp;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  applyMongooseHardening();
  conn = await mongoose.createConnection(mongo.getUri('agrismart-it')).asPromise();
  repos = createMongoRepositories(conn);
  await ensureMongoIndexes(conn); // as the server does before listening
  erp = await startStubErp();
}, 120_000);

afterAll(async () => {
  await conn?.close();
  await mongo?.stop();
  await erp?.close();
});

const newInquiry = (over: Record<string, unknown> = {}) => ({
  reference: 'INQ-ABCDEFGHJK',
  customerId: null,
  kind: 'inquiry' as const,
  name: 'Ravi',
  email: 'ravi@example.com',
  phone: null,
  company: null,
  productInterest: null,
  quantity: null,
  message: 'Hello there, need seeds',
  dedupeKey: 'a'.repeat(64),
  ...over,
});

describe('MongoDB repositories', () => {
  it('enforces unique dedupe keys (concurrent duplicate inquiries)', async () => {
    await repos.inquiries.create(newInquiry());
    await expect(repos.inquiries.create(newInquiry({ reference: 'INQ-BBBBBBBBBB' }))).rejects.toBeInstanceOf(DuplicateKeyError);
  });

  it('startup index check fails loudly when a unique index cannot be built', async () => {
    // Existing duplicate emails make the unique index build fail, as low disk space does.
    const other = await mongoose.createConnection(mongo.getUri('agrismart-it-badindex')).asPromise();
    try {
      await other.db!.collection('customers').insertMany([{ email: 'same@example.com' }, { email: 'same@example.com' }]);
      createMongoRepositories(other);
      await expect(ensureMongoIndexes(other)).rejects.toThrow();
    } finally {
      await other.close();
    }
  });

  it('neutralises operator injection in filters (sanitizeFilter)', async () => {
    // If a raw object ever reached a filter, sanitizeFilter wraps it in $eq: the query is then
    // either rejected (CastError) or matches nothing. It must never match existing documents.
    const injected = { $ne: null } as unknown as string;
    const safe = async (p: Promise<unknown>) => {
      try {
        return await p;
      } catch (err) {
        expect((err as Error).name).toBe('CastError');
        return null;
      }
    };
    expect(await safe(repos.inquiries.findByReference(injected))).toBeNull();
    expect(await safe(repos.users.findByEmail(injected))).toBeNull();
    expect(await repos.inquiries.findByReference('INQ-ABCDEFGHJK')).not.toBeNull();
  });

  it('rejects unknown fields (strict schemas, mass assignment)', async () => {
    await expect(
      repos.inquiries.create({ ...newInquiry({ reference: 'INQ-CCCCCCCCCC', dedupeKey: 'c'.repeat(64) }), isAdmin: true } as never),
    ).rejects.toThrow();
  });

  it('locks inquiries for sync so only one worker proceeds', async () => {
    const rec = await repos.inquiries.findByReference('INQ-ABCDEFGHJK');
    const now = new Date();
    const [a, b] = await Promise.all([repos.inquiries.claimForSync(rec!.id, now, 60_000), repos.inquiries.claimForSync(rec!.id, now, 60_000)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    await repos.inquiries.updateSync(rec!.id, { lockedUntil: null });
    expect(await repos.inquiries.findDueForSync(new Date(), 6, 10)).toHaveLength(1);
  });

  it('performs atomic order status transitions and unique idempotency keys', async () => {
    const order = {
      reference: 'AGS-ABCDEFGHJK',
      accessTokenHash: 'f'.repeat(64),
      idempotencyKeyHash: 'e'.repeat(64),
      customerId: null,
      customer: { name: 'A', email: 'a@example.com', phone: '9876543210', company: null },
      shippingAddress: { line1: 'x', line2: null, city: 'Pune', state: 'MH', postalCode: '411001', country: 'India' },
      items: [{ itemCode: 'SEED-001', name: 'Seeds', uom: 'Nos', qty: 1, unitPrice: 10, lineTotal: 10 }],
      currency: 'INR',
      subtotal: 10,
      priceList: 'MRP',
      notes: null,
    };
    await repos.orders.create(order);
    await expect(repos.orders.create({ ...order, reference: 'AGS-BBBBBBBBBB' })).rejects.toBeInstanceOf(DuplicateKeyError);
    // Orders without idempotency keys do not collide with each other.
    await repos.orders.create({ ...order, reference: 'AGS-CCCCCCCCCC', idempotencyKeyHash: null });
    await repos.orders.create({ ...order, reference: 'AGS-DDDDDDDDDD', idempotencyKeyHash: null });
    expect(await repos.orders.transitionStatus('AGS-ABCDEFGHJK', ['confirmed'], 'fulfilled')).toBeNull();
    expect((await repos.orders.transitionStatus('AGS-ABCDEFGHJK', ['pending_review'], 'confirmed'))?.status).toBe('confirmed');
    expect((await repos.orders.list({ status: 'confirmed' }, 1, 10)).total).toBe(1);
  });

  it('expires sessions, separates staff/customer kinds and revokes per subject', async () => {
    const now = new Date();
    const later = new Date(Date.now() + 3_600_000);
    await repos.sessions.create({ tokenHash: '1'.repeat(64), kind: 'staff', subjectId: 'u1', expiresAt: new Date(Date.now() - 1000), lastSeenAt: now });
    expect(await repos.sessions.findValid('1'.repeat(64), 'staff', now)).toBeNull();
    await repos.sessions.create({ tokenHash: '2'.repeat(64), kind: 'customer', subjectId: 'c1', expiresAt: later, lastSeenAt: now });
    await repos.sessions.create({ tokenHash: '3'.repeat(64), kind: 'customer', subjectId: 'c1', expiresAt: later, lastSeenAt: now });
    // A customer session is never valid as a staff session.
    expect(await repos.sessions.findValid('2'.repeat(64), 'staff', now)).toBeNull();
    expect(await repos.sessions.findValid('2'.repeat(64), 'customer', now)).not.toBeNull();
    await repos.sessions.deleteBySubject('customer', 'c1', '2'.repeat(64));
    expect(await repos.sessions.findValid('2'.repeat(64), 'customer', now)).not.toBeNull();
    expect(await repos.sessions.findValid('3'.repeat(64), 'customer', now)).toBeNull();
    expect(await repos.users.findById('not-an-object-id')).toBeNull();
  });

  it('enforces unique customer emails and stores no plaintext password', async () => {
    const c = await repos.customers.create({ email: 'farmer@example.com', name: 'Farmer', phone: '+919876543210', passwordHash: '$2b$12$abc' });
    await expect(
      repos.customers.create({ email: 'FARMER@example.com', name: 'Other', phone: '+919876543211', passwordHash: '$2b$12$def' }),
    ).rejects.toBeInstanceOf(DuplicateKeyError);
    // Unknown fields such as a role cannot be written to customer records.
    await expect(
      repos.customers.create({ email: 'x@example.com', name: 'X', phone: '+919876543212', passwordHash: 'h', role: 'admin' } as never),
    ).rejects.toThrow();
    const raw = await conn.collection('customers').findOne({ email: 'farmer@example.com' });
    expect(Object.keys(raw!)).not.toContain('password');
    expect(raw).not.toHaveProperty('role');
    await expect(repos.customers.changeEmail(c.id, 'x2@example.com', new Date())).resolves.toBeUndefined();
  });

  it('consumes tokens exactly once, even under concurrency, and rejects expired ones', async () => {
    const now = new Date();
    await repos.customerTokens.create({ tokenHash: 'a'.repeat(64), customerId: 'c9', purpose: 'reset_password', newEmail: null, expiresAt: new Date(Date.now() + 60_000) });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => repos.customerTokens.consume('a'.repeat(64), ['reset_password'], now)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await repos.customerTokens.consume('a'.repeat(64), ['reset_password'], now)).toBeNull();

    await repos.customerTokens.create({ tokenHash: 'b'.repeat(64), customerId: 'c9', purpose: 'reset_password', newEmail: null, expiresAt: new Date(now.getTime() - 1000) });
    expect(await repos.customerTokens.consume('b'.repeat(64), ['reset_password'], now)).toBeNull();
    // Wrong purpose: a verification token cannot be used as a reset token.
    await repos.customerTokens.create({ tokenHash: 'c'.repeat(64), customerId: 'c9', purpose: 'verify_email', newEmail: null, expiresAt: new Date(Date.now() + 60_000) });
    expect(await repos.customerTokens.consume('c'.repeat(64), ['reset_password'], now)).toBeNull();
    expect(await repos.customerTokens.countIssuedSince('c9', 'reset_password', new Date(Date.now() - 60_000))).toBe(2);
  });

  it('caps the address book atomically and scopes address edits to their owner', async () => {
    const a = await repos.customers.create({ email: 'addr-a@example.com', name: 'A', phone: '+919876543213', passwordHash: 'h' });
    const b = await repos.customers.create({ email: 'addr-b@example.com', name: 'B', phone: '+919876543214', passwordHash: 'h' });
    const addr = (n: number) => ({ id: `00000000-0000-4000-8000-00000000000${n}`, label: null, line1: `${n} Farm Road`, line2: null, city: 'Pune', state: 'MH', postalCode: '411001', country: 'India' });
    // Eight concurrent adds against a limit of five: exactly five succeed.
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => repos.customers.addAddress(a.id, addr(i), 5)));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect((await repos.customers.findById(a.id))!.addresses).toHaveLength(5);
    const owned = results.find(Boolean)!;
    expect(await repos.customers.updateAddress(b.id, { ...owned, city: 'Stolen' })).toBeNull();
    expect(await repos.customers.deleteAddress(b.id, owned.id)).toBe(false);
    expect(await repos.customers.updateAddress(a.id, { ...owned, city: 'Nashik' })).toMatchObject({ city: 'Nashik' });
    expect(await repos.customers.deleteAddress(a.id, owned.id)).toBe(true);
    expect((await repos.customers.findById(a.id))!.addresses.map((x) => x.city)).not.toContain('Nashik');
  });

  it('reads records created before customer accounts were required', async () => {
    await conn.collection('inquiries').insertOne({
      reference: 'INQ-LEGACYAAAA', name: 'Old', email: 'old@example.com', message: 'Legacy inquiry text', dedupeKey: 'l'.repeat(64),
      syncStatus: 'synced', attempts: 1, createdAt: new Date(), updatedAt: new Date(),
    });
    expect(await repos.inquiries.findByReference('INQ-LEGACYAAAA')).toMatchObject({ customerId: null, kind: 'inquiry', quantity: null });
    await conn.collection('customers').insertOne({ email: 'legacy@example.com', name: 'Legacy', phone: '+919876543215', passwordHash: 'h', emailVerified: true });
    expect((await repos.customers.findByEmail('legacy@example.com'))!.addresses).toEqual([]);
  });

  it('lets exactly one of several concurrent registrations of the same (normalised) email succeed', async () => {
    const variants = ['race@example.com', 'RACE@example.com', ' race@example.com ', 'Race@Example.COM'];
    const results = await Promise.allSettled(
      variants.map((email, i) => repos.customers.create({ email, name: `R${i}`, phone: '+919876543210', passwordHash: 'h' })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(DuplicateKeyError);
    expect(await conn.collection('customers').countDocuments({ email: 'race@example.com' })).toBe(1);
  });

  describe('E-commerce User registry queue (real MongoDB)', () => {
    const insertLegacy = async (email: string, verified = true) => {
      // As written before the registry existed: no accountStatus, activity or registrySync fields.
      const { insertedId } = await conn.collection('customers').insertOne({
        email,
        name: 'Legacy',
        phone: '+919876543210',
        passwordHash: 'h',
        emailVerified: verified,
        createdAt: new Date(Date.now() - 86400_000),
      });
      return insertedId.toString();
    };
    const syncOnce = async (id: string) => {
      const c = await repos.customers.claimRegistrySync(id, new Date(), 60_000);
      expect(c).not.toBeNull();
      expect(await repos.customers.completeRegistrySync(id, c!.registrySync.lockToken!, c!.registrySync.version, new Date(), 'ECU-TEST-00001')).toBe(true);
      return c!.registrySync.version;
    };
    const state = async (id: string) => (await repos.customers.findById(id))!.registrySync;

    it('legacy customer: first sync, then a later change advances the version, is queued and synced (regression)', async () => {
      const id = await insertLegacy('legacy-reg@example.com');
      expect(await state(id)).toMatchObject({ version: 1, syncedVersion: 0 }); // effective legacy defaults
      expect((await repos.customers.findDueForRegistrySync(new Date(), 500)).map((c) => c.id)).toContain(id);
      const first = await syncOnce(id);
      expect(await state(id)).toMatchObject({ version: first, syncedVersion: first });

      await repos.customers.recordLogin(id, new Date()); // the change that used to be lost
      const after = await state(id);
      expect(after.version).toBeGreaterThan(after.syncedVersion);
      expect((await repos.customers.findDueForRegistrySync(new Date(Date.now() + 1000), 500)).map((c) => c.id)).toContain(id);

      const second = await syncOnce(id);
      expect(second).toBe(after.version);
      expect(await state(id)).toMatchObject({ version: second, syncedVersion: second, pendingSince: null });
    });

    it('a change during an in-flight sync stays queued; the late completion never moves versions back', async () => {
      const id = await insertLegacy('inflight@example.com');
      const claimed = (await repos.customers.claimRegistrySync(id, new Date(), 60_000))!;
      await repos.customers.recordActivity(id, new Date(), 0); // newer change while ERPNext is being updated
      expect(await repos.customers.completeRegistrySync(id, claimed.registrySync.lockToken!, claimed.registrySync.version, new Date(), 'ECU-TEST-00001')).toBe(true);
      const s = await state(id);
      expect(s.syncedVersion).toBe(claimed.registrySync.version);
      expect(s.version).toBeGreaterThan(s.syncedVersion);
      const latest = await syncOnce(id);
      expect(await state(id)).toMatchObject({ syncedVersion: latest });
    });

    it('concurrent changes each advance the version atomically; only one worker gets the lock', async () => {
      const c = await repos.customers.create({ email: 'concurrent@example.com', name: 'C', phone: '+919876543217', passwordHash: 'h' });
      await repos.customers.markEmailVerified(c.id, new Date());
      const v0 = (await state(c.id)).version;
      await Promise.all(Array.from({ length: 10 }, (_, i) => repos.customers.recordLogin(c.id, new Date(Date.now() + i))));
      expect((await state(c.id)).version).toBe(v0 + 10);
      const claims = await Promise.all(Array.from({ length: 5 }, () => repos.customers.claimRegistrySync(c.id, new Date(), 60_000)));
      expect(claims.filter(Boolean)).toHaveLength(1);
    });

    it('a worker whose lock expired cannot complete; the customer is re-queued', async () => {
      const id = await insertLegacy('lost-lock@example.com');
      const t0 = new Date();
      const a = (await repos.customers.claimRegistrySync(id, t0, 1000))!;
      const b = (await repos.customers.claimRegistrySync(id, new Date(t0.getTime() + 5000), 1000))!;
      expect(await repos.customers.completeRegistrySync(id, b.registrySync.lockToken!, b.registrySync.version, new Date(), 'ECU-TEST-00001')).toBe(true);
      const synced = (await state(id)).syncedVersion;
      expect(await repos.customers.completeRegistrySync(id, a.registrySync.lockToken!, a.registrySync.version, new Date(), 'ECU-TEST-00001')).toBe(false);
      const s = await state(id);
      expect(s.syncedVersion).toBe(synced);
      expect(s.version).toBeGreaterThan(s.syncedVersion);
      // A failure report from the stale worker is ignored too.
      await repos.customers.failRegistrySync(id, a.registrySync.lockToken!, { attempts: 9, nextAttemptAt: null, lastErrorKind: 'timeout', failure: 'exhausted', at: new Date() });
      expect((await state(id)).failure).toBeNull();
    });

    it('activity during an outage keeps the backoff; permanent failures survive changes until retried', async () => {
      const id = await insertLegacy('outage@example.com');
      const c = (await repos.customers.claimRegistrySync(id, new Date(), 60_000))!;
      const next = new Date(Date.now() + 3600_000);
      await repos.customers.failRegistrySync(id, c.registrySync.lockToken!, { attempts: 3, nextAttemptAt: next, lastErrorKind: 'timeout', failure: null, at: new Date() });
      await repos.customers.recordLogin(id, new Date());
      await repos.customers.recordActivity(id, new Date(Date.now() + 1), 0);
      expect(await state(id)).toMatchObject({ attempts: 3, nextAttemptAt: next, lastErrorKind: 'timeout', failure: null });
      expect((await repos.customers.findDueForRegistrySync(new Date(), 500)).map((x) => x.id)).not.toContain(id);

      const again = (await repos.customers.claimRegistrySync(id, new Date(), 60_000))!;
      await repos.customers.failRegistrySync(id, again.registrySync.lockToken!, { attempts: 4, nextAttemptAt: null, lastErrorKind: 'validation', failure: 'permanent', at: new Date() });
      await repos.customers.setAccountStatus(id, 'suspended', new Date());
      expect(await state(id)).toMatchObject({ failure: 'permanent', lastErrorKind: 'validation' });
      expect(await repos.customers.claimRegistrySync(id, new Date(), 60_000)).toBeNull();
      expect((await repos.customers.listRegistryFailures(100)).map((r) => r.customerId)).toContain(id);
      const health = await repos.customers.registryHealth(new Date());
      expect(health.failedPermanent).toBeGreaterThanOrEqual(1);
      expect(health.errorKinds.validation).toBeGreaterThanOrEqual(1);

      expect(await repos.customers.retryFailedRegistrySync(new Date(), 'exhausted', id)).toBe(0);
      expect(await repos.customers.retryFailedRegistrySync(new Date(), 'permanent', id)).toBe(1);
      expect((await repos.customers.findDueForRegistrySync(new Date(Date.now() + 1000), 500)).map((x) => x.id)).toContain(id);
    });

    it('unverified accounts are never due; health counts them separately; values are stored literally', async () => {
      const id = await insertLegacy('unverified-legacy@example.com', false);
      expect((await repos.customers.findDueForRegistrySync(new Date(), 500)).map((x) => x.id)).not.toContain(id);
      expect(await repos.customers.claimRegistrySync(id, new Date(), 60_000)).toBeNull();
      expect((await repos.customers.registryHealth(new Date())).awaitingEmailVerification).toBeGreaterThanOrEqual(1);
      // Update pipelines must not interpret "$..." values as field paths, and must normalise emails.
      await repos.customers.changeEmail(id, '  A$Name@Example.COM ', new Date());
      expect((await repos.customers.findById(id))!.email).toBe('a$name@example.com');
      await repos.customers.updateProfile(id, { name: '$name' });
      expect((await repos.customers.findById(id))!.name).toBe('$name');
      // The unique index still protects emails changed through a pipeline.
      await expect(repos.customers.changeEmail(id, 'legacy-reg@example.com', new Date())).rejects.toBeInstanceOf(DuplicateKeyError);
    });

    it('report counts treat legacy records as active accounts', async () => {
      const total = await repos.customers.count({});
      const nonActive = (await repos.customers.count({ accountStatus: 'suspended' })) + (await repos.customers.count({ accountStatus: 'inactive' }));
      expect(await repos.customers.count({ accountStatus: 'active' })).toBe(total - nonActive);
    });
  });
});

describe('full API on MongoDB', () => {
  it('runs inquiry, order and admin flows end-to-end against real repositories', async () => {
    const config = loadConfig(testEnv(erp.url));
    const logger = createLogger('silent');
    const services = buildServices(config, logger, repos);
    const app = createApp({ config, logger, repos, services, isReady: () => conn.readyState === 1 });

    expect((await request(app).get('/api/health/ready')).status).toBe(200);
    const customer = await customerSession(app, repos, { email: 'meena@example.com', name: 'Meena Shah' });
    const inq = await customer.post('/api/inquiries', { kind: 'quotation', name: 'Meena Shah', productInterest: 'FERT-010', quantity: 10, message: 'Need a quote for fertilizer.' });
    expect(inq.status).toBe(202);
    expect(inq.body.crmSync).toBe('synced');
    expect((await customer.agent.get('/api/customer/inquiries')).body.items).toMatchObject([{ reference: inq.body.reference, kind: 'quotation', quantity: 10 }]);

    const ord = await customer.post('/api/orders', {
      customer: { name: 'Meena Shah', phone: '9876543210' },
      shippingAddress: { line1: '12 Farm Road', city: 'Pune', state: 'Maharashtra', postalCode: '411001' },
      saveAddress: true,
      items: [{ itemCode: 'FERT-010', qty: 2 }],
      acceptTerms: true,
    });
    expect(ord.status).toBe(201);
    expect(ord.body.order.subtotal).toBe(798);
    expect(ord.body.addressSaved).toBe(true);
    const view = await request(app).get(`/api/orders/${ord.body.order.reference}`).set('X-Order-Token', ord.body.accessToken);
    expect(view.status).toBe(200);
    expect((await customer.agent.get('/api/customer/orders')).body.items).toMatchObject([{ reference: ord.body.order.reference }]);

    await repos.users.create({ email: 'admin@example.com', passwordHash: await hashPassword('Correct-Horse-42'), role: 'admin' });
    const agent = request.agent(app);
    expect((await agent.post('/api/auth/login').set('Origin', ALLOWED_ORIGIN).send({ email: 'admin@example.com', password: 'Correct-Horse-42' })).status).toBe(200);
    const list = await agent.get('/api/admin/inquiries');
    expect(list.status).toBe(200);
    expect(list.body.items[0]).not.toHaveProperty('dedupeKey');
  });
});
