import { randomUUID } from 'node:crypto';
import mongoose, { Schema, type Model } from 'mongoose';
import {
  ACCOUNT_STATUSES,
  DuplicateKeyError,
  INQUIRY_KINDS,
  REGISTRY_ERROR_KINDS,
  ORDER_STATUSES,
  type CustomerRecord,
  type CustomerRepository,
  type CustomerTokenRecord,
  type CustomerTokenRepository,
  ROLES,
  type InquiryRecord,
  type InquiryRepository,
  type OrderRecord,
  type OrderRepository,
  type Page,
  type Repositories,
  type RegistryFailure,
  type SessionRecord,
  type SessionRepository,
  type UserRecord,
  type UserRepository,
} from '../types.js';

/**
 * MongoDB repositories. Global `sanitizeFilter` is enabled in db/mongo.ts, so every
 * operator object that we build ourselves is wrapped individually in `mongoose.trusted()`.
 * User input never reaches a filter without first passing a Zod schema.
 */
const trusted = <T>(v: T): T => mongoose.trusted(v) as T;

const strictOpts = { strict: 'throw' as const, timestamps: true, versionKey: false as const };

const inquirySchema = new Schema(
  {
    reference: { type: String, required: true, unique: true, maxlength: 32 },
    customerId: { type: String, default: null, maxlength: 64 },
    kind: { type: String, enum: INQUIRY_KINDS, default: 'inquiry', required: true },
    name: { type: String, required: true, maxlength: 100 },
    email: { type: String, required: true, maxlength: 254, lowercase: true },
    phone: { type: String, default: null, maxlength: 20 },
    company: { type: String, default: null, maxlength: 140 },
    productInterest: { type: String, default: null, maxlength: 140 },
    quantity: { type: Number, default: null, min: 1, max: 100000 },
    message: { type: String, required: true, maxlength: 2000 },
    dedupeKey: { type: String, required: true, unique: true, maxlength: 64 },
    syncStatus: { type: String, enum: ['pending', 'synced', 'failed'], default: 'pending', required: true },
    erpLeadName: { type: String, default: null, maxlength: 140 },
    commentSynced: { type: Boolean, default: false },
    attempts: { type: Number, default: 0, min: 0 },
    nextAttemptAt: { type: Date, default: () => new Date() },
    lastErrorKind: { type: String, default: null, maxlength: 40 },
    lockedUntil: { type: Date, default: null },
  },
  strictOpts,
);
inquirySchema.index({ email: 1, createdAt: -1 });
inquirySchema.index({ syncStatus: 1, nextAttemptAt: 1 });
inquirySchema.index({ createdAt: -1 });
inquirySchema.index({ customerId: 1, createdAt: -1 });

const money = { type: Number, required: true, min: 0 };
const orderSchema = new Schema(
  {
    reference: { type: String, required: true, unique: true, maxlength: 32 },
    accessTokenHash: { type: String, required: true, maxlength: 64 },
    idempotencyKeyHash: { type: String, default: null, maxlength: 64 },
    customerId: { type: String, default: null, maxlength: 64 },
    customer: {
      name: { type: String, required: true, maxlength: 100 },
      email: { type: String, required: true, maxlength: 254, lowercase: true },
      phone: { type: String, required: true, maxlength: 20 },
      company: { type: String, default: null, maxlength: 140 },
    },
    shippingAddress: {
      line1: { type: String, required: true, maxlength: 200 },
      line2: { type: String, default: null, maxlength: 200 },
      city: { type: String, required: true, maxlength: 100 },
      state: { type: String, required: true, maxlength: 100 },
      postalCode: { type: String, required: true, maxlength: 12 },
      country: { type: String, required: true, maxlength: 60 },
    },
    items: {
      type: [
        new Schema(
          {
            itemCode: { type: String, required: true, maxlength: 140 },
            name: { type: String, required: true, maxlength: 300 },
            uom: { type: String, required: true, maxlength: 40 },
            qty: { type: Number, required: true, min: 1, max: 10000 },
            unitPrice: money,
            lineTotal: money,
          },
          { _id: false, strict: 'throw' },
        ),
      ],
      validate: [(v: unknown[]) => v.length > 0 && v.length <= 50, 'Order must have 1-50 lines'],
    },
    currency: { type: String, required: true, maxlength: 3 },
    subtotal: money,
    priceList: { type: String, required: true, maxlength: 140 },
    notes: { type: String, default: null, maxlength: 1000 },
    status: { type: String, enum: ORDER_STATUSES, default: 'pending_review', required: true },
  },
  strictOpts,
);
orderSchema.index(
  { idempotencyKeyHash: 1 },
  { unique: true, partialFilterExpression: { idempotencyKeyHash: { $type: 'string' } } },
);
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ customerId: 1, createdAt: -1 });

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, maxlength: 254 },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ROLES, required: true },
    disabled: { type: Boolean, default: false },
    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
  },
  strictOpts,
);

const sessionSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true, maxlength: 64 },
    kind: { type: String, enum: ['staff', 'customer'], required: true },
    subjectId: { type: String, required: true, maxlength: 64 },
    expiresAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
  },
  strictOpts,
);
sessionSchema.index({ kind: 1, subjectId: 1 });
// MongoDB removes expired sessions automatically.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const customerSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, trim: true, lowercase: true, maxlength: 254 },
    name: { type: String, required: true, maxlength: 100 },
    phone: { type: String, required: true, maxlength: 20 },
    passwordHash: { type: String, required: true, maxlength: 100 },
    emailVerified: { type: Boolean, default: false },
    emailVerifiedAt: { type: Date, default: null },
    failedLoginCount: { type: Number, default: 0, min: 0 },
    lockedUntil: { type: Date, default: null },
    addresses: {
      type: [
        new Schema(
          {
            id: { type: String, required: true, maxlength: 36 },
            label: { type: String, default: null, maxlength: 40 },
            line1: { type: String, required: true, maxlength: 200 },
            line2: { type: String, default: null, maxlength: 200 },
            city: { type: String, required: true, maxlength: 100 },
            state: { type: String, required: true, maxlength: 100 },
            postalCode: { type: String, required: true, maxlength: 12 },
            country: { type: String, required: true, maxlength: 60 },
          },
          { _id: false, strict: 'throw' },
        ),
      ],
      default: [],
    },
    accountStatus: { type: String, enum: ACCOUNT_STATUSES, default: 'active', required: true },
    lastLoginAt: { type: Date, default: null },
    lastActivityAt: { type: Date, default: null },
    registrySync: {
      version: { type: Number, default: 1, min: 0 },
      syncedVersion: { type: Number, default: 0, min: 0 },
      attempts: { type: Number, default: 0, min: 0 },
      nextAttemptAt: { type: Date, default: () => new Date() },
      lockedUntil: { type: Date, default: null },
      lockToken: { type: String, default: null, maxlength: 36 },
      lastErrorKind: { type: String, enum: [...REGISTRY_ERROR_KINDS, null], default: null },
      lastErrorAt: { type: Date, default: null },
      failure: { type: String, enum: ['permanent', 'exhausted', null], default: null },
      pendingSince: { type: Date, default: () => new Date() },
      syncedAt: { type: Date, default: null },
      erpName: { type: String, default: null, maxlength: 140 },
    },
  },
  strictOpts,
);
customerSchema.index({ emailVerified: 1, 'registrySync.failure': 1, 'registrySync.nextAttemptAt': 1 });
customerSchema.index({ createdAt: -1 });
customerSchema.index({ lastActivityAt: -1 });

// Effective sync versions. Customers created before the registry existed have no registrySync
// fields: they count as version 1, never synced (0), so they are backfilled once verified.
const V = { $ifNull: ['$registrySync.version', 1] };
const SV = { $ifNull: ['$registrySync.syncedVersion', 0] };

/**
 * Update pipeline for every change to a synced field, as ONE atomic document update:
 *  - applies `set` (values wrapped in $literal: a pipeline would otherwise read "$..." strings as
 *    field paths, and it bypasses schema setters, so callers pass normalised values);
 *  - sets version = max(version, syncedVersion) + 1, so the new version is always above what
 *    ERPNext has, also for legacy records with missing fields (a plain $inc on a missing field
 *    would produce 1 again and the change would never be queued);
 *  - starts a new schedule only when nothing was pending. An existing backoff, attempt count and
 *    failure are kept: activity during an ERPNext outage must not reset the retry policy, and a
 *    failure stays visible until an operator retries it.
 */
function changePipeline(set: Record<string, unknown>, at: Date) {
  const wasPending = { $gt: [V, SV] };
  const literal = Object.fromEntries(Object.entries(set).map(([k, v]) => [k, { $literal: v }]));
  const now = { $literal: at };
  return [
    {
      $set: {
        ...literal,
        updatedAt: now,
        'registrySync.version': { $add: [{ $max: [V, SV] }, 1] },
        'registrySync.syncedVersion': SV,
        'registrySync.attempts': { $cond: [wasPending, { $ifNull: ['$registrySync.attempts', 0] }, 0] },
        'registrySync.nextAttemptAt': { $cond: [wasPending, { $ifNull: ['$registrySync.nextAttemptAt', now] }, now] },
        'registrySync.pendingSince': { $cond: [wasPending, { $ifNull: ['$registrySync.pendingSince', now] }, now] },
      },
    },
  ];
}
const PIPELINE = { updatePipeline: true, timestamps: false } as const;

const customerTokenSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true, maxlength: 64 },
    customerId: { type: String, required: true, maxlength: 64 },
    purpose: { type: String, enum: ['verify_email', 'change_email', 'reset_password'], required: true },
    newEmail: { type: String, default: null, trim: true, lowercase: true, maxlength: 254 },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { ...strictOpts, timestamps: { createdAt: true, updatedAt: false } },
);
customerTokenSchema.index({ customerId: 1, purpose: 1, createdAt: -1 });
// Expired tokens are kept for a day (rate-limit counting), then removed automatically.
customerTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 });

const isDup = (err: unknown) => (err as { code?: number })?.code === 11000;

/**
 * Waits until every model's indexes exist. Duplicate detection (customer emails, order and
 * inquiry references, idempotency keys, inquiry de-duplication) depends on the unique indexes,
 * but Mongoose builds them in the background and only reports failures as events. Without this
 * the API could start and silently accept duplicates, e.g. when MongoDB refuses index builds
 * because the disk is nearly full. Call after createMongoRepositories(), before listening.
 */
export async function ensureMongoIndexes(conn: mongoose.Connection = mongoose.connection): Promise<void> {
  await Promise.all(Object.values(conn.models).map((m) => m.init()));
}

type Doc = Record<string, unknown> & { _id: { toString(): string } };
function toRecord<T>(doc: unknown): T {
  const { _id, updatedAt, ...rest } = doc as Doc;
  return { ...rest, id: _id.toString(), ...(updatedAt !== undefined ? { updatedAt } : {}) } as T;
}

// Documents written before customer accounts were required have no customer link, kind or address book.
const toInquiry = (doc: unknown): InquiryRecord => {
  const i = toRecord<InquiryRecord>(doc);
  return { ...i, customerId: i.customerId ?? null, kind: i.kind ?? 'inquiry', quantity: i.quantity ?? null };
};
const toCustomer = (doc: unknown): CustomerRecord => {
  const c = toRecord<CustomerRecord>(doc);
  const s: Partial<CustomerRecord['registrySync']> = c.registrySync ?? {};
  return {
    ...c,
    addresses: (c.addresses ?? []).map((a) => ({ ...a })),
    accountStatus: c.accountStatus ?? 'active',
    lastLoginAt: c.lastLoginAt ?? null,
    lastActivityAt: c.lastActivityAt ?? null,
    // Customers created before the registry existed have never been synced.
    registrySync: {
      version: s.version ?? 1,
      syncedVersion: s.syncedVersion ?? 0,
      attempts: s.attempts ?? 0,
      nextAttemptAt: s.nextAttemptAt ?? null,
      lockedUntil: s.lockedUntil ?? null,
      lockToken: s.lockToken ?? null,
      lastErrorKind: s.lastErrorKind ?? null,
      lastErrorAt: s.lastErrorAt ?? null,
      failure: s.failure ?? null,
      pendingSince: s.pendingSince ?? null,
      syncedAt: s.syncedAt ?? null,
      erpName: s.erpName ?? null,
    },
  };
};

/** Customers whose current profile version has not reached ERPNext (missing fields = legacy, unsynced). */
const registryPending = () => trusted({ $gt: [V, SV] });
const lockFree = (now: Date) => ({
  $or: [{ 'registrySync.lockedUntil': null }, { 'registrySync.lockedUntil': trusted({ $lte: now }) }],
});

async function paginate<T>(
  model: Model<unknown>,
  filter: Record<string, unknown>,
  page: number,
  pageSize: number,
  map: (doc: unknown) => T = toRecord<T>,
): Promise<Page<T>> {
  const [rows, total] = await Promise.all([
    model
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    model.countDocuments(filter),
  ]);
  return { items: rows.map((r) => map(r)), total, page, pageSize };
}

export function createMongoRepositories(conn: mongoose.Connection = mongoose.connection): Repositories {
  const Inquiry = conn.model('Inquiry', inquirySchema);
  const Order = conn.model('Order', orderSchema);
  const User = conn.model('User', userSchema);
  const Session = conn.model('Session', sessionSchema);
  const Customer = conn.model('Customer', customerSchema);
  const CustomerToken = conn.model('CustomerToken', customerTokenSchema);

  const inquiries: InquiryRepository = {
    async create(data) {
      try {
        return toInquiry((await Inquiry.create(data)).toObject());
      } catch (err) {
        if (isDup(err)) throw new DuplicateKeyError();
        throw err;
      }
    },
    async findByDedupeKey(key) {
      const r = await Inquiry.findOne({ dedupeKey: key }).lean();
      return r ? toInquiry(r) : null;
    },
    async findByReference(reference) {
      const r = await Inquiry.findOne({ reference }).lean();
      return r ? toInquiry(r) : null;
    },
    countByEmailSince(email, since) {
      return Inquiry.countDocuments({ email, createdAt: trusted({ $gte: since }) });
    },
    async claimForSync(id, now, lockMs) {
      const r = await Inquiry.findOneAndUpdate(
        { _id: id, $or: [{ lockedUntil: null }, { lockedUntil: trusted({ $lte: now }) }] },
        { $set: { lockedUntil: new Date(now.getTime() + lockMs) } },
        { returnDocument: 'after' },
      ).lean();
      return r ? toInquiry(r) : null;
    },
    async updateSync(id, patch) {
      await Inquiry.updateOne({ _id: id }, { $set: patch });
    },
    async findDueForSync(now, maxAttempts, limit) {
      const rows = await Inquiry.find(
        {
          syncStatus: trusted({ $ne: 'synced' }),
          attempts: trusted({ $lt: maxAttempts }),
          nextAttemptAt: trusted({ $lte: now }),
          $or: [{ lockedUntil: null }, { lockedUntil: trusted({ $lte: now }) }],
        },
      )
        .sort({ nextAttemptAt: 1 })
        .limit(limit)
        .lean();
      return rows.map((r) => toInquiry(r));
    },
    list(filter, page, pageSize) {
      const query: Record<string, unknown> = {};
      if (filter.syncStatus) query.syncStatus = filter.syncStatus;
      if (filter.customerId !== undefined) query.customerId = filter.customerId;
      return paginate<InquiryRecord>(Inquiry as unknown as Model<unknown>, query, page, pageSize, toInquiry);
    },
  };

  const orders: OrderRepository = {
    async create(data) {
      try {
        return toRecord<OrderRecord>((await Order.create(data)).toObject());
      } catch (err) {
        if (isDup(err)) throw new DuplicateKeyError();
        throw err;
      }
    },
    async findByReference(reference) {
      const r = await Order.findOne({ reference }).lean();
      return r ? toRecord<OrderRecord>(r) : null;
    },
    async findByIdempotencyKeyHash(hash) {
      const r = await Order.findOne({ idempotencyKeyHash: hash }).lean();
      return r ? toRecord<OrderRecord>(r) : null;
    },
    async transitionStatus(reference, from, to) {
      const r = await Order.findOneAndUpdate(
        { reference, status: trusted({ $in: from }) },
        { $set: { status: to } },
        { returnDocument: 'after' },
      ).lean();
      return r ? toRecord<OrderRecord>(r) : null;
    },
    list(filter, page, pageSize) {
      const query: Record<string, unknown> = {};
      if (filter.status) query.status = filter.status;
      if (filter.customerId !== undefined) query.customerId = filter.customerId;
      return paginate<OrderRecord>(Order as unknown as Model<unknown>, query, page, pageSize);
    },
  };

  const users: UserRepository = {
    async findByEmail(email) {
      const r = await User.findOne({ email }).lean();
      return r ? toRecord<UserRecord>(r) : null;
    },
    async findById(id) {
      if (!mongoose.isValidObjectId(id)) return null;
      const r = await User.findById(id).lean();
      return r ? toRecord<UserRecord>(r) : null;
    },
    async create(data) {
      try {
        return toRecord<UserRecord>((await User.create(data)).toObject());
      } catch (err) {
        if (isDup(err)) throw new DuplicateKeyError();
        throw err;
      }
    },
    async updatePassword(id, passwordHash) {
      await User.updateOne({ _id: id }, { $set: { passwordHash, failedLoginCount: 0, lockedUntil: null } });
    },
    async recordFailedLogin(id, lockedUntil) {
      await User.updateOne({ _id: id }, { $inc: { failedLoginCount: 1 }, $set: { lockedUntil } });
    },
    async resetFailedLogins(id) {
      await User.updateOne({ _id: id }, { $set: { failedLoginCount: 0, lockedUntil: null } });
    },
  };

  const sessions: SessionRepository = {
    async create(data) {
      await Session.create(data);
    },
    async findValid(tokenHash, kind, now) {
      const r = await Session.findOne({ tokenHash, kind, expiresAt: trusted({ $gt: now }) }).lean();
      return r ? toRecord<SessionRecord>(r) : null;
    },
    async touch(tokenHash, now) {
      await Session.updateOne({ tokenHash }, { $set: { lastSeenAt: now } });
    },
    async delete(tokenHash) {
      await Session.deleteOne({ tokenHash });
    },
    async deleteBySubject(kind, subjectId, exceptTokenHash) {
      await Session.deleteMany({
        kind,
        subjectId,
        ...(exceptTokenHash ? { tokenHash: trusted({ $ne: exceptTokenHash }) } : {}),
      });
    },
  };

  const customers: CustomerRepository = {
    async create(data) {
      try {
        return toCustomer((await Customer.create(data)).toObject());
      } catch (err) {
        if (isDup(err)) throw new DuplicateKeyError();
        throw err;
      }
    },
    async findByEmail(email) {
      const r = await Customer.findOne({ email }).lean();
      return r ? toCustomer(r) : null;
    },
    async findById(id) {
      if (!mongoose.isValidObjectId(id)) return null;
      const r = await Customer.findById(id).lean();
      return r ? toCustomer(r) : null;
    },
    async updateProfile(id, patch) {
      if (!mongoose.isValidObjectId(id)) return null;
      const set: Record<string, string> = {};
      // Values were validated by the request schema; lengths are re-checked here because update
      // pipelines skip Mongoose validators.
      if (patch.name !== undefined) set.name = patch.name.slice(0, 100);
      if (patch.phone !== undefined) set.phone = patch.phone.slice(0, 20);
      const r = await Customer.findOneAndUpdate({ _id: id }, changePipeline(set, new Date()), { ...PIPELINE, returnDocument: 'after' }).lean();
      return r ? toCustomer(r) : null;
    },
    async updatePassword(id, passwordHash) {
      await Customer.updateOne({ _id: id }, { $set: { passwordHash, failedLoginCount: 0, lockedUntil: null } });
    },
    async markEmailVerified(id, at) {
      if (!mongoose.isValidObjectId(id)) return;
      // Only the first confirmation changes anything (repeated links are no-ops).
      await Customer.updateOne({ _id: id, emailVerified: false }, changePipeline({ emailVerified: true, emailVerifiedAt: at }, at), PIPELINE);
    },
    async changeEmail(id, email, at) {
      if (!mongoose.isValidObjectId(id)) return;
      try {
        // Pipelines bypass the schema's lowercase setter, so normalise here; the unique index
        // still rejects an address owned by another account.
        const normalized = email.trim().toLowerCase();
        await Customer.updateOne({ _id: id }, changePipeline({ email: normalized, emailVerified: true, emailVerifiedAt: at }, at), PIPELINE);
      } catch (err) {
        if (isDup(err)) throw new DuplicateKeyError();
        throw err;
      }
    },
    async recordFailedLogin(id, lockedUntil) {
      await Customer.updateOne({ _id: id }, { $inc: { failedLoginCount: 1 }, $set: { lockedUntil } });
    },
    async resetFailedLogins(id) {
      await Customer.updateOne({ _id: id }, { $set: { failedLoginCount: 0, lockedUntil: null } });
    },
    async addAddress(customerId, address, max) {
      if (!mongoose.isValidObjectId(customerId)) return null;
      // The size condition and the push are one atomic update, so concurrent adds cannot exceed `max`.
      // (matchedCount, not modifiedCount: timestamps make every matched update a modification.)
      const r = await Customer.updateOne(
        { _id: customerId, [`addresses.${max - 1}`]: trusted({ $exists: false }) },
        { $push: { addresses: address } },
        { runValidators: true },
      );
      return r.matchedCount === 1 ? { ...address } : null;
    },
    async updateAddress(customerId, address) {
      if (!mongoose.isValidObjectId(customerId)) return null;
      const r = await Customer.updateOne(
        { _id: customerId, 'addresses.id': address.id },
        { $set: { 'addresses.$': address } },
        { runValidators: true },
      );
      return r.matchedCount === 1 ? { ...address } : null;
    },
    async deleteAddress(customerId, addressId) {
      if (!mongoose.isValidObjectId(customerId)) return false;
      const r = await Customer.updateOne({ _id: customerId, 'addresses.id': addressId }, { $pull: { addresses: { id: addressId } } });
      return r.matchedCount === 1;
    },
    async recordLogin(id, at) {
      if (!mongoose.isValidObjectId(id)) return;
      await Customer.updateOne({ _id: id }, changePipeline({ lastLoginAt: at, lastActivityAt: at }, at), PIPELINE);
    },
    async recordActivity(id, at, minIntervalMs) {
      if (!mongoose.isValidObjectId(id)) return false;
      // Conditional, so frequent actions cause at most one write (and one ERPNext update) per interval.
      const r = await Customer.updateOne(
        { _id: id, $or: [{ lastActivityAt: null }, { lastActivityAt: trusted({ $lte: new Date(at.getTime() - minIntervalMs) }) }] },
        changePipeline({ lastActivityAt: at }, at),
        PIPELINE,
      );
      return r.matchedCount === 1;
    },
    async setAccountStatus(id, status, at) {
      if (!mongoose.isValidObjectId(id) || !ACCOUNT_STATUSES.includes(status)) return null;
      await Customer.updateOne({ _id: id, accountStatus: trusted({ $ne: status }) }, changePipeline({ accountStatus: status }, at), PIPELINE);
      const r = await Customer.findById(id).lean();
      return r ? toCustomer(r) : null;
    },
    count(filter) {
      const q: Record<string, unknown> = {};
      if (filter.accountStatus !== undefined) {
        // Records from before account statuses existed are active.
        q.accountStatus = filter.accountStatus === 'active' ? trusted({ $in: ['active', null] }) : filter.accountStatus;
      }
      if (filter.emailVerified !== undefined) q.emailVerified = filter.emailVerified;
      if (filter.createdSince !== undefined) q.createdAt = trusted({ $gte: filter.createdSince });
      if (filter.activeSince !== undefined) q.lastActivityAt = trusted({ $gte: filter.activeSince });
      return Customer.countDocuments(q);
    },
    async findDueForRegistrySync(now, limit) {
      const rows = await Customer.find({
        emailVerified: true,
        $expr: registryPending(),
        'registrySync.failure': null,
        $and: [{ $or: [{ 'registrySync.nextAttemptAt': null }, { 'registrySync.nextAttemptAt': trusted({ $lte: now }) }] }, lockFree(now)],
      })
        .sort({ 'registrySync.nextAttemptAt': 1 })
        .limit(limit)
        .lean();
      return rows.map((r) => toCustomer(r));
    },
    async claimRegistrySync(id, now, lockMs) {
      if (!mongoose.isValidObjectId(id)) return null;
      const r = await Customer.findOneAndUpdate(
        { _id: id, emailVerified: true, $expr: registryPending(), 'registrySync.failure': null, ...lockFree(now) },
        { $set: { 'registrySync.lockedUntil': new Date(now.getTime() + lockMs), 'registrySync.lockToken': randomUUID() } },
        { returnDocument: 'after', timestamps: false },
      ).lean();
      return r ? toCustomer(r) : null;
    },
    async completeRegistrySync(id, lockToken, version, at, erpName) {
      const now = { $literal: at };
      const newVersion = { $max: [V, version] };
      const newSynced = { $max: [SV, version] }; // never backwards, even for a late completion
      const r = await Customer.updateOne(
        { _id: id, 'registrySync.lockToken': lockToken },
        [
          {
            $set: {
              'registrySync.version': newVersion,
              'registrySync.syncedVersion': newSynced,
              'registrySync.attempts': 0,
              'registrySync.failure': null,
              'registrySync.lastErrorKind': null,
              'registrySync.lastErrorAt': null,
              'registrySync.lockedUntil': null,
              'registrySync.lockToken': null,
              'registrySync.syncedAt': now,
              'registrySync.erpName': { $literal: erpName },
              // A change recorded while this sync was in flight is still pending: due now.
              'registrySync.nextAttemptAt': now,
              'registrySync.pendingSince': { $cond: [{ $gt: [newVersion, newSynced] }, now, null] },
            },
          },
        ],
        PIPELINE,
      );
      if (r.matchedCount === 1) return true;
      // Lock lost (expired and taken by another worker): what this worker sent may be older than
      // what the other one sent, so queue a fresh sync of the current data.
      await Customer.updateOne({ _id: id }, changePipeline({}, at), PIPELINE);
      return false;
    },
    async failRegistrySync(id, lockToken, patch) {
      await Customer.updateOne(
        { _id: id, 'registrySync.lockToken': lockToken },
        {
          $set: {
            'registrySync.attempts': patch.attempts,
            'registrySync.nextAttemptAt': patch.nextAttemptAt,
            'registrySync.lastErrorKind': patch.lastErrorKind,
            'registrySync.lastErrorAt': patch.at,
            'registrySync.failure': patch.failure,
            'registrySync.lockedUntil': null,
            'registrySync.lockToken': null,
          },
        },
        { timestamps: false, runValidators: true },
      );
    },
    async releaseRegistrySync(id, lockToken) {
      await Customer.updateOne(
        { _id: id, 'registrySync.lockToken': lockToken },
        { $set: { 'registrySync.lockedUntil': null, 'registrySync.lockToken': null } },
        { timestamps: false },
      );
    },
    async retryFailedRegistrySync(now, scope, customerId) {
      if (customerId !== undefined && !mongoose.isValidObjectId(customerId)) return 0;
      const failures: RegistryFailure[] = scope === 'failed' ? ['permanent', 'exhausted'] : [scope];
      const r = await Customer.updateMany(
        { 'registrySync.failure': trusted({ $in: failures }), ...(customerId ? { _id: customerId } : {}) },
        { $set: { 'registrySync.failure': null, 'registrySync.attempts': 0, 'registrySync.nextAttemptAt': now } },
        { timestamps: false },
      );
      return r.matchedCount;
    },
    async listRegistryFailures(limit) {
      const rows = await Customer.find({ 'registrySync.failure': trusted({ $in: ['permanent', 'exhausted'] }) })
        .select({ registrySync: 1 })
        .sort({ 'registrySync.lastErrorAt': 1 })
        .limit(limit)
        .lean();
      return rows.map((r) => {
        const s = toCustomer({ ...r, createdAt: null }).registrySync;
        return { customerId: String(r._id), failure: s.failure!, lastErrorKind: s.lastErrorKind, attempts: s.attempts, lastErrorAt: s.lastErrorAt, pendingSince: s.pendingSince };
      });
    },
    async registryHealth() {
      type Facets = {
        pending: { n: number; retrying: number; oldest: Date | null; maxAttempts: number }[];
        failed: { _id: string; n: number }[];
        unverified: { n: number }[];
        kinds: { _id: string; n: number }[];
        last: { at: Date | null }[];
      };
      // Aggregation pipelines are not passed through sanitizeFilter; nothing here comes from a request.
      const [f] = await Customer.aggregate<Facets>([
        {
          $project: {
            verified: { $eq: ['$emailVerified', true] },
            pending: { $gt: [V, SV] },
            failure: { $ifNull: ['$registrySync.failure', null] },
            attempts: { $ifNull: ['$registrySync.attempts', 0] },
            since: { $ifNull: ['$registrySync.pendingSince', '$createdAt'] },
            kind: { $ifNull: ['$registrySync.lastErrorKind', null] },
            syncedAt: { $ifNull: ['$registrySync.syncedAt', null] },
          },
        },
        {
          $facet: {
            pending: [
              { $match: { verified: true, pending: true, failure: null } },
              {
                $group: {
                  _id: null,
                  n: { $sum: 1 },
                  retrying: { $sum: { $cond: [{ $gt: ['$attempts', 0] }, 1, 0] } },
                  oldest: { $min: '$since' },
                  maxAttempts: { $max: '$attempts' },
                },
              },
            ],
            failed: [{ $match: { verified: true, pending: true, failure: { $ne: null } } }, { $group: { _id: '$failure', n: { $sum: 1 } } }],
            unverified: [{ $match: { verified: false, pending: true } }, { $count: 'n' }],
            kinds: [{ $match: { verified: true, pending: true, kind: { $ne: null } } }, { $group: { _id: '$kind', n: { $sum: 1 } } }],
            last: [{ $group: { _id: null, at: { $max: '$syncedAt' } } }],
          },
        },
      ]);
      const failed = new Map(f!.failed.map((x) => [x._id, x.n]));
      return {
        pending: f!.pending[0]?.n ?? 0,
        retrying: f!.pending[0]?.retrying ?? 0,
        failedPermanent: failed.get('permanent') ?? 0,
        failedExhausted: failed.get('exhausted') ?? 0,
        awaitingEmailVerification: f!.unverified[0]?.n ?? 0,
        oldestPendingSince: f!.pending[0]?.oldest ?? null,
        lastSuccessAt: f!.last[0]?.at ?? null,
        maxAttempts: f!.pending[0]?.maxAttempts ?? 0,
        errorKinds: Object.fromEntries(f!.kinds.map((k) => [k._id, k.n])),
      };
    },
  };

  const customerTokens: CustomerTokenRepository = {
    async create(data) {
      await CustomerToken.create(data);
    },
    async findActive(tokenHash, purposes, now) {
      const r = await CustomerToken.findOne({
        tokenHash,
        purpose: trusted({ $in: purposes }),
        usedAt: null,
        expiresAt: trusted({ $gt: now }),
      }).lean();
      return r ? toRecord<CustomerTokenRecord>(r) : null;
    },
    async consume(tokenHash, purposes, now) {
      // Single atomic update: two concurrent requests with the same token cannot both succeed.
      const r = await CustomerToken.findOneAndUpdate(
        { tokenHash, purpose: trusted({ $in: purposes }), usedAt: null, expiresAt: trusted({ $gt: now }) },
        { $set: { usedAt: now } },
        { returnDocument: 'after' },
      ).lean();
      return r ? toRecord<CustomerTokenRecord>(r) : null;
    },
    async invalidate(customerId, purpose, now) {
      await CustomerToken.updateMany({ customerId, purpose, usedAt: null }, { $set: { usedAt: now } });
    },
    countIssuedSince(customerId, purpose, since) {
      return CustomerToken.countDocuments({ customerId, purpose, createdAt: trusted({ $gte: since }) });
    },
  };

  return { inquiries, orders, users, sessions, customers, customerTokens };
}
