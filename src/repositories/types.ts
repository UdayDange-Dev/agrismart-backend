export class DuplicateKeyError extends Error {
  constructor() {
    super('Duplicate key');
    this.name = 'DuplicateKeyError';
  }
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------- Inquiries ----------

export type InquirySyncStatus = 'pending' | 'synced' | 'failed';
/** `quotation`: the customer asked for a price quote; `inquiry`: any other question. */
export const INQUIRY_KINDS = ['inquiry', 'quotation'] as const;
export type InquiryKind = (typeof INQUIRY_KINDS)[number];

export interface InquiryRecord {
  id: string;
  reference: string;
  /** The signed-in customer who sent it (from the session). Null only on records from before accounts were required. */
  customerId: string | null;
  kind: InquiryKind;
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  productInterest: string | null;
  quantity: number | null;
  message: string;
  dedupeKey: string;
  syncStatus: InquirySyncStatus;
  erpLeadName: string | null;
  commentSynced: boolean;
  attempts: number;
  nextAttemptAt: Date | null;
  lastErrorKind: string | null;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NewInquiry = Pick<
  InquiryRecord,
  'reference' | 'customerId' | 'kind' | 'name' | 'email' | 'phone' | 'company' | 'productInterest' | 'quantity' | 'message' | 'dedupeKey'
>;

export type InquirySyncPatch = Partial<
  Pick<InquiryRecord, 'syncStatus' | 'erpLeadName' | 'commentSynced' | 'attempts' | 'nextAttemptAt' | 'lastErrorKind' | 'lockedUntil'>
>;

export interface InquiryRepository {
  /** @throws DuplicateKeyError when an identical inquiry already exists */
  create(data: NewInquiry): Promise<InquiryRecord>;
  findByDedupeKey(key: string): Promise<InquiryRecord | null>;
  findByReference(reference: string): Promise<InquiryRecord | null>;
  countByEmailSince(email: string, since: Date): Promise<number>;
  /** Atomically lock an inquiry for syncing; returns null when another worker holds it. */
  claimForSync(id: string, now: Date, lockMs: number): Promise<InquiryRecord | null>;
  updateSync(id: string, patch: InquirySyncPatch): Promise<void>;
  findDueForSync(now: Date, maxAttempts: number, limit: number): Promise<InquiryRecord[]>;
  list(filter: { syncStatus?: InquirySyncStatus; customerId?: string }, page: number, pageSize: number): Promise<Page<InquiryRecord>>;
}

// ---------- Orders ----------

export const ORDER_STATUSES = ['pending_review', 'confirmed', 'cancelled', 'fulfilled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface OrderLine {
  itemCode: string;
  name: string;
  uom: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
}

export interface OrderRecord {
  id: string;
  reference: string;
  accessTokenHash: string;
  idempotencyKeyHash: string | null;
  /** Set when the order was placed by a signed-in customer; the only link used for order history. */
  customerId: string | null;
  customer: { name: string; email: string; phone: string; company: string | null };
  shippingAddress: { line1: string; line2: string | null; city: string; state: string; postalCode: string; country: string };
  items: OrderLine[];
  currency: string;
  subtotal: number;
  priceList: string;
  notes: string | null;
  status: OrderStatus;
  createdAt: Date;
  updatedAt: Date;
}

export type NewOrder = Omit<OrderRecord, 'id' | 'createdAt' | 'updatedAt' | 'status'>;

export interface OrderRepository {
  /** @throws DuplicateKeyError on reference or idempotency key collision */
  create(data: NewOrder): Promise<OrderRecord>;
  findByReference(reference: string): Promise<OrderRecord | null>;
  findByIdempotencyKeyHash(hash: string): Promise<OrderRecord | null>;
  /** Atomic compare-and-set status transition. Returns null if the current status did not match. */
  transitionStatus(reference: string, from: OrderStatus[], to: OrderStatus): Promise<OrderRecord | null>;
  list(filter: { status?: OrderStatus; customerId?: string }, page: number, pageSize: number): Promise<Page<OrderRecord>>;
}

// ---------- Users & sessions ----------

export const ROLES = ['admin', 'staff'] as const;
export type Role = (typeof ROLES)[number];

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  disabled: boolean;
  failedLoginCount: number;
  lockedUntil: Date | null;
  createdAt: Date;
}

export interface UserRepository {
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  /** @throws DuplicateKeyError when the email already exists */
  create(data: { email: string; passwordHash: string; role: Role }): Promise<UserRecord>;
  updatePassword(id: string, passwordHash: string): Promise<void>;
  recordFailedLogin(id: string, lockedUntil: Date | null): Promise<void>;
  resetFailedLogins(id: string): Promise<void>;
}

/** Staff (back office) and customers have separate identities, cookies and session kinds. */
export type SessionKind = 'staff' | 'customer';

export interface SessionRecord {
  tokenHash: string;
  kind: SessionKind;
  subjectId: string;
  expiresAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
}

export interface SessionRepository {
  create(data: Omit<SessionRecord, 'createdAt'>): Promise<void>;
  /** Returns the session only if it matches the kind and has not reached its absolute expiry. */
  findValid(tokenHash: string, kind: SessionKind, now: Date): Promise<SessionRecord | null>;
  touch(tokenHash: string, now: Date): Promise<void>;
  delete(tokenHash: string): Promise<void>;
  /** Revokes every session of a subject, optionally keeping one (the caller's current session). */
  deleteBySubject(kind: SessionKind, subjectId: string, exceptTokenHash?: string): Promise<void>;
}

// ---------- Customers ----------

export interface AddressFields {
  label: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

/** A delivery address in the customer's own address book. `id` is a random UUID. */
export interface SavedAddress extends AddressFields {
  id: string;
}

/** Only `active` accounts can sign in. Set by staff on the server (`npm run user-registry`). */
export const ACCOUNT_STATUSES = ['active', 'inactive', 'suspended'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** Safe, non-personal error categories recorded for registry sync attempts. */
export const REGISTRY_ERROR_KINDS = [
  'timeout',
  'network',
  'rate_limited',
  'upstream',
  'invalid_response',
  'validation',
  'duplicate_email',
  'lock_lost',
  'internal',
] as const;
export type RegistryErrorKind = (typeof REGISTRY_ERROR_KINDS)[number];

/**
 * Why a registry sync stopped retrying. Only an operator retry clears it; a new customer change
 * does not (the failure must stay visible until someone has looked at it).
 *  - `permanent`: ERPNext rejected this customer's data (validation, duplicate email).
 *  - `exhausted`: transient errors reached the attempt limit.
 */
export type RegistryFailure = 'permanent' | 'exhausted';

/**
 * Sync state of the customer's profile copy in the ERPNext "E-commerce User" registry.
 * Every change to a synced field sets `version = max(version, syncedVersion) + 1` in one atomic
 * update; the sync job pushes the current snapshot and records the version it sent (never
 * moving backwards), so retries resend state and never duplicate or lose a newer change.
 * Only customers with a confirmed email are synced.
 */
export interface RegistrySyncState {
  version: number;
  syncedVersion: number;
  attempts: number;
  nextAttemptAt: Date | null;
  lockedUntil: Date | null;
  /** Identifies the worker holding the lock; completion and failure only apply with the same token. */
  lockToken: string | null;
  lastErrorKind: RegistryErrorKind | null;
  lastErrorAt: Date | null;
  failure: RegistryFailure | null;
  /** When the oldest unsynced change was queued (for health reporting). */
  pendingSince: Date | null;
  syncedAt: Date | null;
  /** Name of this customer's ERPNext record (e.g. ECU-2026-00001) once a sync created or adopted it. */
  erpName: string | null;
}

export interface RegistryHealth {
  /** Verified customers with unsynced changes that will be retried automatically. */
  pending: number;
  /** Of those, how many have failed at least once and are backing off. */
  retrying: number;
  failedPermanent: number;
  failedExhausted: number;
  /** Unconfirmed accounts are not sent to ERPNext (policy); shown for completeness. */
  awaitingEmailVerification: number;
  oldestPendingSince: Date | null;
  lastSuccessAt: Date | null;
  maxAttempts: number;
  /** Counts of the last error category among pending and failed customers. */
  errorKinds: Partial<Record<RegistryErrorKind, number>>;
}

export type RegistryRetryScope = 'failed' | 'permanent' | 'exhausted';

export interface RegistryFailureRow {
  customerId: string;
  failure: RegistryFailure;
  lastErrorKind: RegistryErrorKind | null;
  attempts: number;
  lastErrorAt: Date | null;
  pendingSince: Date | null;
}

/** Customers have no role field at all: a customer record can never grant staff access. */
export interface CustomerRecord {
  id: string;
  email: string;
  name: string;
  phone: string;
  passwordHash: string;
  emailVerified: boolean;
  emailVerifiedAt: Date | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
  addresses: SavedAddress[];
  accountStatus: AccountStatus;
  lastLoginAt: Date | null;
  /** Last meaningful action (sign-in, order, inquiry, account change), at most every few minutes. */
  lastActivityAt: Date | null;
  registrySync: RegistrySyncState;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomerCountFilter {
  accountStatus?: AccountStatus;
  emailVerified?: boolean;
  createdSince?: Date;
  activeSince?: Date;
}

export interface CustomerRepository {
  /** @throws DuplicateKeyError when the email is already registered */
  create(data: { email: string; name: string; phone: string; passwordHash: string }): Promise<CustomerRecord>;
  findByEmail(email: string): Promise<CustomerRecord | null>;
  findById(id: string): Promise<CustomerRecord | null>;
  updateProfile(id: string, patch: { name?: string; phone?: string }): Promise<CustomerRecord | null>;
  /** Also clears lockout state. */
  updatePassword(id: string, passwordHash: string): Promise<void>;
  markEmailVerified(id: string, at: Date): Promise<void>;
  /** @throws DuplicateKeyError when the new email belongs to another account */
  changeEmail(id: string, email: string, at: Date): Promise<void>;
  recordFailedLogin(id: string, lockedUntil: Date | null): Promise<void>;
  resetFailedLogins(id: string): Promise<void>;
  /** Atomically appends unless the customer already has `max` addresses; null when full or not found. */
  addAddress(customerId: string, address: SavedAddress, max: number): Promise<SavedAddress | null>;
  /** Matches only an address inside this customer's own record; null when there is none. */
  updateAddress(customerId: string, address: SavedAddress): Promise<SavedAddress | null>;
  /** Returns false when this customer has no address with that id. */
  deleteAddress(customerId: string, addressId: string): Promise<boolean>;

  // Activity and account status (each change also queues an ERPNext registry sync).
  recordLogin(id: string, at: Date): Promise<void>;
  /** Sets lastActivityAt only if it is older than `minIntervalMs`; returns whether it changed. */
  recordActivity(id: string, at: Date, minIntervalMs: number): Promise<boolean>;
  setAccountStatus(id: string, status: AccountStatus, at: Date): Promise<CustomerRecord | null>;
  count(filter: CustomerCountFilter): Promise<number>;

  // ERPNext registry sync queue. Only customers with a confirmed email are ever due or claimable.
  /** Verified customers with unsynced changes, not failed, due and not locked. */
  findDueForRegistrySync(now: Date, limit: number): Promise<CustomerRecord[]>;
  /**
   * Atomically locks the customer for syncing under a new lock token; null when locked elsewhere,
   * failed, unverified or nothing to sync. Does not check the backoff schedule.
   */
  claimRegistrySync(id: string, now: Date, lockMs: number): Promise<CustomerRecord | null>;
  /**
   * Records that `version` is now in ERPNext and releases the lock, only if `lockToken` still holds
   * it. Versions never move backwards. Returns false when the lock was lost (another worker may
   * have synced since); the change is then re-queued so ERPNext ends with the newest data.
   */
  completeRegistrySync(id: string, lockToken: string, version: number, at: Date, erpName: string): Promise<boolean>;
  /** Records a failed attempt and releases the lock (only with the same lock token). */
  failRegistrySync(
    id: string,
    lockToken: string,
    patch: { attempts: number; nextAttemptAt: Date | null; lastErrorKind: RegistryErrorKind; failure: RegistryFailure | null; at: Date },
  ): Promise<void>;
  /** Releases the lock without recording an attempt (e.g. the whole integration is paused). */
  releaseRegistrySync(id: string, lockToken: string): Promise<void>;
  /** Operator action: re-queues failed syncs (all, or one customer); returns how many. */
  retryFailedRegistrySync(now: Date, scope: RegistryRetryScope, customerId?: string): Promise<number>;
  registryHealth(now: Date): Promise<RegistryHealth>;
  /** Operator view of failed syncs: ids and safe error categories only, oldest first. */
  listRegistryFailures(limit: number): Promise<RegistryFailureRow[]>;
}

export type TokenPurpose = 'verify_email' | 'change_email' | 'reset_password';

export interface CustomerTokenRecord {
  tokenHash: string;
  customerId: string;
  purpose: TokenPurpose;
  /** Only for change_email: the address being verified. */
  newEmail: string | null;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface CustomerTokenRepository {
  create(data: Omit<CustomerTokenRecord, 'usedAt' | 'createdAt'>): Promise<void>;
  /** Reads an unused, unexpired token without consuming it. */
  findActive(tokenHash: string, purposes: TokenPurpose[], now: Date): Promise<CustomerTokenRecord | null>;
  /** Atomically marks an unused, unexpired token as used and returns it; null otherwise. */
  consume(tokenHash: string, purposes: TokenPurpose[], now: Date): Promise<CustomerTokenRecord | null>;
  /** Marks all outstanding tokens of this purpose as used (only the newest link should work). */
  invalidate(customerId: string, purpose: TokenPurpose, now: Date): Promise<void>;
  countIssuedSince(customerId: string, purpose: TokenPurpose, since: Date): Promise<number>;
}

export interface Repositories {
  inquiries: InquiryRepository;
  orders: OrderRepository;
  users: UserRepository;
  sessions: SessionRepository;
  customers: CustomerRepository;
  customerTokens: CustomerTokenRepository;
}
