import { randomUUID } from 'node:crypto';
import {
  DuplicateKeyError,
  type CustomerCountFilter,
  type RegistryFailureRow,
  type RegistryHealth,
  type RegistryRetryScope,
  type CustomerRecord,
  type CustomerRepository,
  type CustomerTokenRecord,
  type CustomerTokenRepository,
  type SessionKind,
  type TokenPurpose,
  type InquiryRecord,
  type InquiryRepository,
  type OrderRecord,
  type OrderRepository,
  type Page,
  type Repositories,
  type SavedAddress,
  type SessionRecord,
  type SessionRepository,
  type UserRecord,
  type UserRepository,
} from './types.js';

/** In-memory repositories for tests and local experiments. Not for production use. */

function paginate<T>(rows: T[], page: number, pageSize: number): Page<T> {
  return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize };
}

const byNewest = (a: { createdAt: Date }, b: { createdAt: Date }) => b.createdAt.getTime() - a.createdAt.getTime();

class MemoryInquiries implements InquiryRepository {
  rows = new Map<string, InquiryRecord>();

  async create(data: Parameters<InquiryRepository['create']>[0]) {
    if ([...this.rows.values()].some((r) => r.dedupeKey === data.dedupeKey || r.reference === data.reference)) {
      throw new DuplicateKeyError();
    }
    const now = new Date();
    const rec: InquiryRecord = {
      ...data,
      id: randomUUID(),
      syncStatus: 'pending',
      erpLeadName: null,
      commentSynced: false,
      attempts: 0,
      nextAttemptAt: now,
      lastErrorKind: null,
      lockedUntil: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(rec.id, rec);
    return { ...rec };
  }
  async findByDedupeKey(key: string) {
    const r = [...this.rows.values()].find((x) => x.dedupeKey === key);
    return r ? { ...r } : null;
  }
  async findByReference(reference: string) {
    const r = [...this.rows.values()].find((x) => x.reference === reference);
    return r ? { ...r } : null;
  }
  async countByEmailSince(email: string, since: Date) {
    return [...this.rows.values()].filter((r) => r.email === email && r.createdAt >= since).length;
  }
  async claimForSync(id: string, now: Date, lockMs: number) {
    const r = this.rows.get(id);
    if (!r || (r.lockedUntil && r.lockedUntil > now)) return null;
    r.lockedUntil = new Date(now.getTime() + lockMs);
    return { ...r };
  }
  async updateSync(id: string, patch: Parameters<InquiryRepository['updateSync']>[1]) {
    const r = this.rows.get(id);
    if (r) Object.assign(r, patch, { updatedAt: new Date() });
  }
  async findDueForSync(now: Date, maxAttempts: number, limit: number) {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.syncStatus !== 'synced' &&
          r.attempts < maxAttempts &&
          (!r.nextAttemptAt || r.nextAttemptAt <= now) &&
          (!r.lockedUntil || r.lockedUntil <= now),
      )
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
  async list(filter: { syncStatus?: InquiryRecord['syncStatus']; customerId?: string }, page: number, pageSize: number) {
    const rows = [...this.rows.values()].filter(
      (r) => (!filter.syncStatus || r.syncStatus === filter.syncStatus) && (filter.customerId === undefined || r.customerId === filter.customerId),
    );
    return paginate(rows.sort(byNewest), page, pageSize);
  }
}

class MemoryOrders implements OrderRepository {
  rows = new Map<string, OrderRecord>();

  async create(data: Parameters<OrderRepository['create']>[0]) {
    const all = [...this.rows.values()];
    if (
      all.some(
        (o) => o.reference === data.reference || (data.idempotencyKeyHash && o.idempotencyKeyHash === data.idempotencyKeyHash),
      )
    ) {
      throw new DuplicateKeyError();
    }
    const now = new Date();
    const rec: OrderRecord = { ...structuredClone(data), id: randomUUID(), status: 'pending_review', createdAt: now, updatedAt: now };
    this.rows.set(rec.reference, rec);
    return structuredClone(rec);
  }
  async findByReference(reference: string) {
    const r = this.rows.get(reference);
    return r ? structuredClone(r) : null;
  }
  async findByIdempotencyKeyHash(hash: string) {
    const r = [...this.rows.values()].find((o) => o.idempotencyKeyHash === hash);
    return r ? structuredClone(r) : null;
  }
  async transitionStatus(reference: string, from: OrderRecord['status'][], to: OrderRecord['status']) {
    const r = this.rows.get(reference);
    if (!r || !from.includes(r.status)) return null;
    r.status = to;
    r.updatedAt = new Date();
    return structuredClone(r);
  }
  async list(filter: { status?: OrderRecord['status']; customerId?: string }, page: number, pageSize: number) {
    const rows = [...this.rows.values()].filter(
      (o) => (!filter.status || o.status === filter.status) && (filter.customerId === undefined || o.customerId === filter.customerId),
    );
    return paginate(rows.sort(byNewest).map((r) => structuredClone(r)), page, pageSize);
  }
}

class MemoryUsers implements UserRepository {
  rows = new Map<string, UserRecord>();

  async findByEmail(email: string) {
    const r = [...this.rows.values()].find((u) => u.email === email);
    return r ? { ...r } : null;
  }
  async findById(id: string) {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  }
  async create(data: Parameters<UserRepository['create']>[0]) {
    if (await this.findByEmail(data.email)) throw new DuplicateKeyError();
    const rec: UserRecord = { ...data, id: randomUUID(), disabled: false, failedLoginCount: 0, lockedUntil: null, createdAt: new Date() };
    this.rows.set(rec.id, rec);
    return { ...rec };
  }
  async updatePassword(id: string, passwordHash: string) {
    const r = this.rows.get(id);
    if (r) r.passwordHash = passwordHash;
  }
  async recordFailedLogin(id: string, lockedUntil: Date | null) {
    const r = this.rows.get(id);
    if (r) {
      r.failedLoginCount += 1;
      r.lockedUntil = lockedUntil;
    }
  }
  async resetFailedLogins(id: string) {
    const r = this.rows.get(id);
    if (r) {
      r.failedLoginCount = 0;
      r.lockedUntil = null;
    }
  }
}

class MemorySessions implements SessionRepository {
  rows = new Map<string, SessionRecord>();

  async create(data: Omit<SessionRecord, 'createdAt'>) {
    this.rows.set(data.tokenHash, { ...data, createdAt: new Date() });
  }
  async findValid(tokenHash: string, kind: SessionKind, now: Date) {
    const r = this.rows.get(tokenHash);
    return r && r.kind === kind && r.expiresAt > now ? { ...r } : null;
  }
  async touch(tokenHash: string, now: Date) {
    const r = this.rows.get(tokenHash);
    if (r) r.lastSeenAt = now;
  }
  async delete(tokenHash: string) {
    this.rows.delete(tokenHash);
  }
  async deleteBySubject(kind: SessionKind, subjectId: string, exceptTokenHash?: string) {
    for (const [k, v] of this.rows) {
      if (v.kind === kind && v.subjectId === subjectId && k !== exceptTokenHash) this.rows.delete(k);
    }
  }
}

/**
 * Marks a customer's synced profile as changed, with the same rules as the MongoDB pipeline:
 * version = max(version, syncedVersion) + 1; an existing backoff or failure is kept.
 */
function bumpRegistry(r: CustomerRecord, at: Date) {
  const s = r.registrySync;
  const wasPending = s.version > s.syncedVersion;
  Object.assign(s, {
    version: Math.max(s.version, s.syncedVersion) + 1,
    attempts: wasPending ? s.attempts : 0,
    nextAttemptAt: wasPending ? (s.nextAttemptAt ?? at) : at,
    pendingSince: wasPending ? (s.pendingSince ?? at) : at,
  });
  r.updatedAt = at;
}

const newRegistryState = (now: Date): CustomerRecord['registrySync'] => ({
  version: 1,
  syncedVersion: 0,
  attempts: 0,
  nextAttemptAt: now,
  lockedUntil: null,
  lockToken: null,
  lastErrorKind: null,
  lastErrorAt: null,
  failure: null,
  pendingSince: now,
  syncedAt: null,
  erpName: null,
});

class MemoryCustomers implements CustomerRepository {
  rows = new Map<string, CustomerRecord>();

  private byEmail(email: string) {
    const normalized = email.trim().toLowerCase();
    return [...this.rows.values()].find((c) => c.email === normalized);
  }
  async create(data: Parameters<CustomerRepository['create']>[0]) {
    if (this.byEmail(data.email)) throw new DuplicateKeyError();
    const now = new Date();
    const rec: CustomerRecord = {
      ...data,
      email: data.email.trim().toLowerCase(),
      id: randomUUID(),
      emailVerified: false,
      emailVerifiedAt: null,
      failedLoginCount: 0,
      lockedUntil: null,
      addresses: [],
      accountStatus: 'active',
      lastLoginAt: null,
      lastActivityAt: null,
      registrySync: newRegistryState(now),
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(rec.id, rec);
    return structuredClone(rec);
  }
  async recordLogin(id: string, at: Date) {
    const r = this.rows.get(id);
    if (!r) return;
    Object.assign(r, { lastLoginAt: at, lastActivityAt: at });
    bumpRegistry(r, at);
  }
  async recordActivity(id: string, at: Date, minIntervalMs: number) {
    const r = this.rows.get(id);
    if (!r || (r.lastActivityAt && r.lastActivityAt.getTime() > at.getTime() - minIntervalMs)) return false;
    r.lastActivityAt = at;
    bumpRegistry(r, at);
    return true;
  }
  async setAccountStatus(id: string, status: CustomerRecord['accountStatus'], at: Date) {
    const r = this.rows.get(id);
    if (!r) return null;
    if (r.accountStatus !== status) {
      r.accountStatus = status;
      bumpRegistry(r, at);
    }
    return structuredClone(r);
  }
  async count(filter: CustomerCountFilter) {
    return [...this.rows.values()].filter(
      (c) =>
        (filter.accountStatus === undefined || c.accountStatus === filter.accountStatus) &&
        (filter.emailVerified === undefined || c.emailVerified === filter.emailVerified) &&
        (filter.createdSince === undefined || c.createdAt >= filter.createdSince) &&
        (filter.activeSince === undefined || (c.lastActivityAt !== null && c.lastActivityAt >= filter.activeSince)),
    ).length;
  }
  private pending(c: CustomerRecord) {
    return c.registrySync.version > c.registrySync.syncedVersion;
  }
  private lockFree(c: CustomerRecord, now: Date) {
    return !c.registrySync.lockedUntil || c.registrySync.lockedUntil <= now;
  }
  async findDueForRegistrySync(now: Date, limit: number) {
    return [...this.rows.values()]
      .filter(
        (c) =>
          c.emailVerified &&
          this.pending(c) &&
          c.registrySync.failure === null &&
          (!c.registrySync.nextAttemptAt || c.registrySync.nextAttemptAt <= now) &&
          this.lockFree(c, now),
      )
      .slice(0, limit)
      .map((c) => structuredClone(c));
  }
  async claimRegistrySync(id: string, now: Date, lockMs: number) {
    const r = this.rows.get(id);
    if (!r || !r.emailVerified || !this.pending(r) || r.registrySync.failure !== null || !this.lockFree(r, now)) return null;
    Object.assign(r.registrySync, { lockedUntil: new Date(now.getTime() + lockMs), lockToken: randomUUID() });
    return structuredClone(r);
  }
  async completeRegistrySync(id: string, lockToken: string, version: number, at: Date, erpName: string) {
    const r = this.rows.get(id);
    if (!r) return false;
    const s = r.registrySync;
    if (s.lockToken !== lockToken) {
      bumpRegistry(r, at); // lock lost: re-queue the current data
      return false;
    }
    const newVersion = Math.max(s.version, version);
    const newSynced = Math.max(s.syncedVersion, version);
    Object.assign(s, {
      version: newVersion,
      syncedVersion: newSynced,
      attempts: 0,
      failure: null,
      lastErrorKind: null,
      lastErrorAt: null,
      lockedUntil: null,
      lockToken: null,
      syncedAt: at,
      erpName,
      nextAttemptAt: at,
      pendingSince: newVersion > newSynced ? at : null,
    });
    return true;
  }
  async failRegistrySync(id: string, lockToken: string, patch: Parameters<CustomerRepository['failRegistrySync']>[2]) {
    const r = this.rows.get(id);
    if (!r || r.registrySync.lockToken !== lockToken) return;
    Object.assign(r.registrySync, {
      attempts: patch.attempts,
      nextAttemptAt: patch.nextAttemptAt,
      lastErrorKind: patch.lastErrorKind,
      lastErrorAt: patch.at,
      failure: patch.failure,
      lockedUntil: null,
      lockToken: null,
    });
  }
  async releaseRegistrySync(id: string, lockToken: string) {
    const r = this.rows.get(id);
    if (r && r.registrySync.lockToken === lockToken) Object.assign(r.registrySync, { lockedUntil: null, lockToken: null });
  }
  async retryFailedRegistrySync(now: Date, scope: RegistryRetryScope, customerId?: string) {
    let n = 0;
    for (const r of this.rows.values()) {
      const f = r.registrySync.failure;
      if (f === null || (customerId !== undefined && r.id !== customerId) || (scope !== 'failed' && scope !== f)) continue;
      Object.assign(r.registrySync, { failure: null, attempts: 0, nextAttemptAt: now });
      n += 1;
    }
    return n;
  }
  async listRegistryFailures(limit: number): Promise<RegistryFailureRow[]> {
    return [...this.rows.values()]
      .filter((c) => c.registrySync.failure !== null)
      .sort((a, b) => (a.registrySync.lastErrorAt?.getTime() ?? 0) - (b.registrySync.lastErrorAt?.getTime() ?? 0))
      .slice(0, limit)
      .map((c) => ({
        customerId: c.id,
        failure: c.registrySync.failure!,
        lastErrorKind: c.registrySync.lastErrorKind,
        attempts: c.registrySync.attempts,
        lastErrorAt: c.registrySync.lastErrorAt,
        pendingSince: c.registrySync.pendingSince,
      }));
  }
  async registryHealth(): Promise<RegistryHealth> {
    const all = [...this.rows.values()];
    const pendingVerified = all.filter((c) => c.emailVerified && this.pending(c));
    const active = pendingVerified.filter((c) => c.registrySync.failure === null);
    const errorKinds: RegistryHealth['errorKinds'] = {};
    for (const c of pendingVerified) {
      const k = c.registrySync.lastErrorKind;
      if (k) errorKinds[k] = (errorKinds[k] ?? 0) + 1;
    }
    const times = (xs: (Date | null)[]) => xs.filter((d): d is Date => d !== null).map((d) => d.getTime());
    const oldest = times(active.map((c) => c.registrySync.pendingSince ?? c.createdAt));
    const synced = times(all.map((c) => c.registrySync.syncedAt));
    return {
      pending: active.length,
      retrying: active.filter((c) => c.registrySync.attempts > 0).length,
      failedPermanent: pendingVerified.filter((c) => c.registrySync.failure === 'permanent').length,
      failedExhausted: pendingVerified.filter((c) => c.registrySync.failure === 'exhausted').length,
      awaitingEmailVerification: all.filter((c) => !c.emailVerified && this.pending(c)).length,
      oldestPendingSince: oldest.length ? new Date(Math.min(...oldest)) : null,
      lastSuccessAt: synced.length ? new Date(Math.max(...synced)) : null,
      maxAttempts: Math.max(0, ...active.map((c) => c.registrySync.attempts)),
      errorKinds,
    };
  }
  async findByEmail(email: string) {
    const r = this.byEmail(email);
    return r ? structuredClone(r) : null;
  }
  async findById(id: string) {
    const r = this.rows.get(id);
    return r ? structuredClone(r) : null;
  }
  async updateProfile(id: string, patch: { name?: string; phone?: string }) {
    const r = this.rows.get(id);
    if (!r) return null;
    Object.assign(r, patch, { updatedAt: new Date() });
    bumpRegistry(r, new Date());
    return structuredClone(r);
  }
  async addAddress(customerId: string, address: SavedAddress, max: number) {
    const r = this.rows.get(customerId);
    if (!r || r.addresses.length >= max) return null;
    r.addresses.push(structuredClone(address));
    return structuredClone(address);
  }
  async updateAddress(customerId: string, address: SavedAddress) {
    const r = this.rows.get(customerId);
    const i = r?.addresses.findIndex((a) => a.id === address.id) ?? -1;
    if (!r || i < 0) return null;
    r.addresses[i] = structuredClone(address);
    return structuredClone(address);
  }
  async deleteAddress(customerId: string, addressId: string) {
    const r = this.rows.get(customerId);
    const before = r?.addresses.length ?? 0;
    if (r) r.addresses = r.addresses.filter((a) => a.id !== addressId);
    return (r?.addresses.length ?? 0) < before;
  }
  async updatePassword(id: string, passwordHash: string) {
    const r = this.rows.get(id);
    if (r) Object.assign(r, { passwordHash, failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() });
  }
  async markEmailVerified(id: string, at: Date) {
    const r = this.rows.get(id);
    if (r && !r.emailVerified) {
      Object.assign(r, { emailVerified: true, emailVerifiedAt: at });
      bumpRegistry(r, at);
    }
  }
  async changeEmail(id: string, email: string, at: Date) {
    const other = this.byEmail(email);
    if (other && other.id !== id) throw new DuplicateKeyError();
    const r = this.rows.get(id);
    if (r) {
      Object.assign(r, { email: email.trim().toLowerCase(), emailVerified: true, emailVerifiedAt: at, updatedAt: at });
      bumpRegistry(r, at);
    }
  }
  async recordFailedLogin(id: string, lockedUntil: Date | null) {
    const r = this.rows.get(id);
    if (r) Object.assign(r, { failedLoginCount: r.failedLoginCount + 1, lockedUntil });
  }
  async resetFailedLogins(id: string) {
    const r = this.rows.get(id);
    if (r) Object.assign(r, { failedLoginCount: 0, lockedUntil: null });
  }
}

class MemoryCustomerTokens implements CustomerTokenRepository {
  rows: CustomerTokenRecord[] = [];

  async create(data: Omit<CustomerTokenRecord, 'usedAt' | 'createdAt'>) {
    this.rows.push({ ...data, usedAt: null, createdAt: new Date() });
  }
  async findActive(tokenHash: string, purposes: TokenPurpose[], now: Date) {
    const r = this.rows.find((t) => t.tokenHash === tokenHash && purposes.includes(t.purpose) && !t.usedAt && t.expiresAt > now);
    return r ? { ...r } : null;
  }
  async consume(tokenHash: string, purposes: TokenPurpose[], now: Date) {
    const r = this.rows.find((t) => t.tokenHash === tokenHash && purposes.includes(t.purpose) && !t.usedAt && t.expiresAt > now);
    if (!r) return null;
    r.usedAt = now;
    return { ...r };
  }
  async invalidate(customerId: string, purpose: TokenPurpose, now: Date) {
    for (const t of this.rows) if (t.customerId === customerId && t.purpose === purpose && !t.usedAt) t.usedAt = now;
  }
  async countIssuedSince(customerId: string, purpose: TokenPurpose, since: Date) {
    return this.rows.filter((t) => t.customerId === customerId && t.purpose === purpose && t.createdAt >= since).length;
  }
}

export function createMemoryRepositories(): Repositories & {
  inquiries: MemoryInquiries;
  orders: MemoryOrders;
  users: MemoryUsers;
  sessions: MemorySessions;
  customers: MemoryCustomers;
  customerTokens: MemoryCustomerTokens;
} {
  return {
    inquiries: new MemoryInquiries(),
    orders: new MemoryOrders(),
    users: new MemoryUsers(),
    sessions: new MemorySessions(),
    customers: new MemoryCustomers(),
    customerTokens: new MemoryCustomerTokens(),
  };
}
