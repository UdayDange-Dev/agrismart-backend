import type { Logger } from 'pino';
import { ErpNextError, type ErpNextClient } from '../integrations/erpnext/client.js';
import type { AccountStatus, CustomerRecord, CustomerRepository, RegistryErrorKind, RegistryFailure } from '../repositories/types.js';
import { describe } from './catalogService.js';
import { formatInTimezone } from './leadSync.js';
import { todayInTimezone } from './pricing.js';

/**
 * ERPNext "E-commerce User" registry: a read-only copy of each website customer's profile and
 * activity for staff reporting. The website (MongoDB) stays the source of truth and the only
 * place that authenticates customers. See erpnext/README.md for the DocType and roles.
 */
export const REGISTRY_DOCTYPE = 'E-commerce User';
/** "Last Activity" is written at most this often per customer (and so at most one ERPNext update). */
export const ACTIVITY_INTERVAL_MS = 10 * 60 * 1000;
const STATUS_LABELS: Record<AccountStatus, 'Active' | 'Inactive' | 'Suspended'> = {
  active: 'Active',
  inactive: 'Inactive',
  suspended: 'Suspended',
};

/** The ERPNext naming series of the E-commerce User DocType (records are named ECU-2026-00001...). */
export const REGISTRY_NAMING_SERIES = 'ECU-.YYYY.-.#####';

/**
 * Exactly the fields of the ERPNext "E-commerce User" DocType that the website maintains. No
 * password hash, tokens, sessions or addresses, by construction. `registration_date` is a Date
 * field (YYYY-MM-DD in the site timezone); datetimes are naive site-timezone values.
 */
export type RegistryDoc = {
  customer_name: string;
  email: string;
  mobile: string;
  registration_date: string;
  email_verified: 0 | 1;
  account_status: 'Active' | 'Inactive' | 'Suspended';
  last_login: string | null;
  last_activity: string | null;
};

/** All fields the website maintains in ERPNext (the DocType must have every one of them). */
export const REGISTRY_FIELDS = [
  'customer_name',
  'email',
  'mobile',
  'registration_date',
  'email_verified',
  'account_status',
  'last_login',
  'last_activity',
] as const satisfies readonly (keyof RegistryDoc)[];

/** Set only when a record is created; never overwritten by later updates. */
const CREATE_ONLY_FIELDS = ['registration_date'] as const;

export function toRegistryDoc(c: CustomerRecord, timezone: string): RegistryDoc {
  const dt = (d: Date | null) => (d ? formatInTimezone(d, timezone) : null);
  return {
    customer_name: c.name,
    email: c.email.trim().toLowerCase(),
    mobile: c.phone,
    registration_date: todayInTimezone(timezone, c.createdAt),
    email_verified: c.emailVerified ? 1 : 0,
    account_status: STATUS_LABELS[c.accountStatus],
    last_login: dt(c.lastLoginAt),
    last_activity: dt(c.lastActivityAt),
  };
}

// ---------------------------------------------------------------- errors and retry policy

/**
 * Problems that affect the whole integration rather than one customer. They pause the sync job
 * (customers keep their state and attempt counts) until a read-only access check passes again.
 */
export type RegistryAccessProblem = 'doctype_missing' | 'auth' | 'permission' | 'write_blocked' | 'unavailable';

/** Classified sync failure. Messages are generic: never upstream bodies, data or credentials. */
export class RegistrySyncError extends Error {
  constructor(
    public readonly scope: 'transient' | 'permanent' | 'config',
    public readonly kind: RegistryErrorKind | RegistryAccessProblem,
    public readonly retryAfterMs?: number,
  ) {
    super(`ERPNext user registry: ${scope} ${kind}`);
    this.name = 'RegistrySyncError';
  }
}

/**
 * Retry policy (documented in erpnext/README.md):
 *  - transient (timeout, network, HTTP 429, 5xx, malformed response): exponential backoff with
 *    jitter, 1 min doubling to at most 6 h, at least any Retry-After; after 8 attempts the sync is
 *    marked `exhausted` and waits for an operator retry;
 *  - permanent (HTTP 400/417 validation, 409 email owned by another record): marked `permanent`
 *    at once, never retried automatically;
 *  - configuration (401/403, missing DocType, write guard): the job pauses; no customer is charged
 *    an attempt or marked failed.
 */
export const MAX_REGISTRY_ATTEMPTS = 8;
export const RETRY_BASE_MS = 60 * 1000;
export const RETRY_CAP_MS = 6 * 60 * 60 * 1000;

/** Delay before attempt `attempts + 1`: "equal jitter" = half fixed, half random. */
export function retryDelayMs(attempts: number, random: () => number = Math.random, retryAfterMs?: number): number {
  const exp = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
  const jittered = Math.round(exp / 2 + random() * (exp / 2));
  return Math.max(jittered, retryAfterMs ?? 0);
}

/** Maps a client error to a registry outcome. A read-by-name 404 (missing record) is handled by the caller. */
export function classifyRegistryError(err: unknown): RegistrySyncError {
  if (err instanceof RegistrySyncError) return err;
  if (!(err instanceof ErpNextError)) return new RegistrySyncError('transient', 'internal');
  switch (err.kind) {
    case 'write_blocked':
      return new RegistrySyncError('config', 'write_blocked');
    case 'auth':
      return new RegistrySyncError('config', err.status === 401 ? 'auth' : 'permission');
    case 'not_found':
      // Not a missing record (handled before): a 404 on list, insert or update means the DocType is missing.
      return new RegistrySyncError('config', 'doctype_missing');
    case 'validation':
      return new RegistrySyncError('permanent', err.status === 409 ? 'duplicate_email' : 'validation');
    case 'upstream':
      return new RegistrySyncError('transient', err.status === 429 ? 'rate_limited' : 'upstream', err.retryAfterMs);
    case 'timeout':
    case 'network':
    case 'invalid_response':
      return new RegistrySyncError('transient', err.kind);
  }
  return new RegistrySyncError('transient', 'internal');
}

// ---------------------------------------------------------------- ERPNext gateway

export interface UpsertResult {
  result: 'created' | 'updated';
  /** The ERPNext document name (e.g. ECU-2026-00001), stored on the customer for later updates. */
  name: string;
}

export interface UserRegistryGateway {
  /** `knownName`: the ERPNext record this customer was linked to by an earlier sync, if any. */
  upsert(doc: RegistryDoc, knownName: string | null): Promise<UpsertResult>;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,139}$/;

/**
 * Idempotent upsert for a DocType named by a naming series (ERPNext chooses the name):
 *  1. Customer already linked (name stored in MongoDB): PUT that record. If it was deleted in
 *     ERPNext, continue with 2.
 *  2. Not linked yet (first sync, or an earlier create whose response was lost): find records with
 *     the customer's normalised email. One match: adopt and update it. Several: permanent
 *     `duplicate_email` (staff must merge them; nothing is guessed). None: POST a new record.
 * Updates never send `naming_series` or `registration_date`, so the original values are kept.
 * Throws RegistrySyncError.
 */
export class ErpNextUserRegistry implements UserRegistryGateway {
  constructor(private readonly client: ErpNextClient) {}

  private async put(name: string, doc: RegistryDoc): Promise<boolean> {
    const fields: Record<string, unknown> = { ...doc };
    for (const f of CREATE_ONLY_FIELDS) delete fields[f];
    try {
      await this.client.update(REGISTRY_DOCTYPE, name, fields);
      return true;
    } catch (err) {
      if (err instanceof ErpNextError && err.kind === 'not_found') return false; // deleted in ERPNext
      throw classifyRegistryError(err);
    }
  }

  private async findByEmail(email: string): Promise<string[]> {
    try {
      const rows = await this.client.getList(REGISTRY_DOCTYPE, { fields: ['name'], filters: [['email', '=', email]], limit: 2 });
      return rows.map((r) => r.name).filter((n): n is string => typeof n === 'string' && NAME.test(n));
    } catch (err) {
      throw classifyRegistryError(err);
    }
  }

  async upsert(doc: RegistryDoc, knownName: string | null): Promise<UpsertResult> {
    if (knownName && (await this.put(knownName, doc))) return { result: 'updated', name: knownName };
    const matches = await this.findByEmail(doc.email);
    if (matches.length > 1) throw new RegistrySyncError('permanent', 'duplicate_email');
    if (matches.length === 1) {
      if (await this.put(matches[0]!, doc)) return { result: 'updated', name: matches[0]! };
      throw new RegistrySyncError('transient', 'upstream'); // vanished between list and update: retry
    }
    let created: Record<string, unknown>;
    try {
      created = await this.client.insert(REGISTRY_DOCTYPE, { naming_series: REGISTRY_NAMING_SERIES, ...doc });
    } catch (err) {
      throw classifyRegistryError(err);
    }
    if (typeof created.name !== 'string' || !NAME.test(created.name)) throw new RegistrySyncError('transient', 'invalid_response');
    return { result: 'created', name: created.name };
  }
}

/**
 * Read-only check that the DocType exists and the integration user can read it. Run before the
 * sync starts (server startup) and before job runs, so a missing DocType pauses the integration
 * instead of failing every customer.
 */
export async function checkRegistryAccess(client: ErpNextClient): Promise<{ ok: true } | { ok: false; problem: RegistryAccessProblem }> {
  try {
    await client.getList(REGISTRY_DOCTYPE, { fields: ['name'], limit: 1 });
    return { ok: true };
  } catch (err) {
    if (err instanceof ErpNextError) {
      if (err.kind === 'not_found') return { ok: false, problem: 'doctype_missing' };
      if (err.kind === 'auth') return { ok: false, problem: err.status === 401 ? 'auth' : 'permission' };
    }
    return { ok: false, problem: 'unavailable' };
  }
}

/** Problems that a restart cannot fix: the server refuses to start with sync enabled. */
export const DEFINITIVE_ACCESS_PROBLEMS: ReadonlySet<RegistryAccessProblem> = new Set(['doctype_missing', 'auth', 'permission', 'write_blocked']);

// ---------------------------------------------------------------- sync one customer

export type SyncOutcome =
  | { status: 'synced'; result: 'created' | 'updated'; name: string }
  | { status: 'retry'; kind: RegistryErrorKind; attempts: number; nextAttemptAt: Date }
  | { status: 'failed'; kind: RegistryErrorKind; failure: RegistryFailure }
  | { status: 'paused'; problem: RegistryAccessProblem }
  | { status: 'requeued' }
  | { status: 'locked' };

const LOCK_MS = 2 * 60 * 1000;

/**
 * Pushes one verified customer's current profile to ERPNext. Safe to repeat and to run in several
 * workers: the customer is locked under a token, the whole current snapshot is sent, and only the
 * lock holder can record the result (a worker whose lock expired re-queues instead, so ERPNext
 * always ends with the newest data). Changes made meanwhile stay queued.
 */
export async function syncCustomerToRegistry(
  repo: CustomerRepository,
  gateway: UserRegistryGateway,
  customerId: string,
  opts: { timezone: string; random?: () => number; lockMs?: number },
  logger: Logger,
  now: () => Date = () => new Date(),
): Promise<SyncOutcome> {
  const customer = await repo.claimRegistrySync(customerId, now(), opts.lockMs ?? LOCK_MS);
  if (!customer) return { status: 'locked' };
  const token = customer.registrySync.lockToken!;
  const { version, attempts: previous } = customer.registrySync;
  try {
    const { result, name } = await gateway.upsert(toRegistryDoc(customer, opts.timezone), customer.registrySync.erpName);
    if (!(await repo.completeRegistrySync(customer.id, token, version, now(), name))) {
      logger.warn({ customerId: customer.id }, 'Registry sync lock expired before completion; re-queued');
      return { status: 'requeued' };
    }
    logger.info({ customerId: customer.id, erpName: name, result }, 'Customer synced to the ERPNext user registry');
    return { status: 'synced', result, name };
  } catch (err) {
    const e = classifyRegistryError(err);
    if (e.scope === 'config') {
      await repo.releaseRegistrySync(customer.id, token);
      return { status: 'paused', problem: e.kind as RegistryAccessProblem };
    }
    const kind = e.kind as RegistryErrorKind;
    const attempts = previous + 1;
    const at = now();
    const failure: RegistryFailure | null = e.scope === 'permanent' ? 'permanent' : attempts >= MAX_REGISTRY_ATTEMPTS ? 'exhausted' : null;
    const nextAttemptAt = failure ? null : new Date(at.getTime() + retryDelayMs(attempts, opts.random, e.retryAfterMs));
    await repo.failRegistrySync(customer.id, token, { attempts, nextAttemptAt, lastErrorKind: kind, failure, at });
    // No profile data in logs: the customer id identifies the record for staff.
    logger.warn({ customerId: customer.id, attempts, kind, failure }, 'ERPNext user registry sync failed');
    return failure ? { status: 'failed', kind, failure } : { status: 'retry', kind, attempts, nextAttemptAt: nextAttemptAt! };
  }
}

// ---------------------------------------------------------------- background job

/** In-process state of the sync job, for the staff health endpoint. No personal data. */
export class RegistryMonitor {
  state: 'disabled' | 'starting' | 'ready' | 'blocked' = 'starting';
  problem: RegistryAccessProblem | null = null;
  lastCheckAt: Date | null = null;
  lastRunAt: Date | null = null;
  lastSyncAt: Date | null = null;

  constructor(enabled: boolean) {
    if (!enabled) this.state = 'disabled';
  }

  recordCheck(result: { ok: true } | { ok: false; problem: RegistryAccessProblem }, at: Date): void {
    this.lastCheckAt = at;
    this.state = result.ok ? 'ready' : 'blocked';
    this.problem = result.ok ? null : result.problem;
  }

  needsCheck(at: Date, recheckMs: number): boolean {
    return this.state !== 'ready' || !this.lastCheckAt || at.getTime() - this.lastCheckAt.getTime() >= recheckMs;
  }

  snapshot() {
    return {
      state: this.state,
      problem: this.problem,
      lastCheckAt: this.lastCheckAt?.toISOString() ?? null,
      lastRunAt: this.lastRunAt?.toISOString() ?? null,
      lastSyncAt: this.lastSyncAt?.toISOString() ?? null,
    };
  }
}

/**
 * One job run: (re)check access when due, then sync up to `batch` due customers. Stops at the first
 * configuration problem. Exported for tests; `startUserRegistryJob` runs it on an interval.
 */
export async function runRegistryJobOnce(
  repo: CustomerRepository,
  gateway: UserRegistryGateway,
  checkAccess: () => Promise<{ ok: true } | { ok: false; problem: RegistryAccessProblem }>,
  monitor: RegistryMonitor,
  opts: { timezone: string; recheckMs?: number; batch?: number; random?: () => number },
  logger: Logger,
  now: () => Date = () => new Date(),
): Promise<void> {
  monitor.lastRunAt = now();
  if (monitor.needsCheck(now(), opts.recheckMs ?? 15 * 60 * 1000)) {
    const result = await checkAccess();
    const wasBlocked = monitor.state === 'blocked';
    monitor.recordCheck(result, now());
    if (!result.ok) {
      if (!wasBlocked) logger.error({ problem: result.problem }, 'ERPNext user registry paused: access check failed');
      return;
    }
  }
  const due = await repo.findDueForRegistrySync(now(), opts.batch ?? 25);
  for (const c of due) {
    const outcome = await syncCustomerToRegistry(repo, gateway, c.id, opts, logger, now);
    if (outcome.status === 'synced') monitor.lastSyncAt = now();
    if (outcome.status === 'paused') {
      monitor.recordCheck({ ok: false, problem: outcome.problem }, now());
      logger.error({ problem: outcome.problem }, 'ERPNext user registry paused during sync');
      return;
    }
  }
}

/** Runs the sync on an interval in this process. Overlapping runs are skipped. */
export function startUserRegistryJob(
  repo: CustomerRepository,
  gateway: UserRegistryGateway,
  checkAccess: () => Promise<{ ok: true } | { ok: false; problem: RegistryAccessProblem }>,
  monitor: RegistryMonitor,
  opts: { timezone: string; intervalMs: number },
  logger: Logger,
): () => void {
  if (opts.intervalMs <= 0) {
    logger.warn('ERPNext user registry sync is enabled but its interval is 0: the job does not run');
    return () => undefined;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runRegistryJobOnce(repo, gateway, checkAccess, monitor, opts, logger);
    } catch (err) {
      logger.error({ err: describe(err) }, 'User registry sync job failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------- reporting

/** UTC instant of 00:00 on `date` (YYYY-MM-DD) in `timezone`. */
export function startOfDayInTimezone(date: string, timezone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asLocal = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return new Date(guess - (asLocal - guess));
}

/** Start of the window "the last `days` days, including today", in the site timezone. */
export function windowStart(days: number, timezone: string, now: Date): Date {
  const today = startOfDayInTimezone(todayInTimezone(timezone, now), timezone);
  // Step back by calendar days via the date string, so a DST change elsewhere cannot shift it.
  const d = new Date(today.getTime() + 12 * 3600 * 1000 - (days - 1) * 86400 * 1000);
  return startOfDayInTimezone(todayInTimezone(timezone, d), timezone);
}

export interface UserStats {
  totalRegistered: number;
  activeAccounts: number;
  inactiveAccounts: number;
  suspendedAccounts: number;
  emailVerified: number;
  newLast7Days: number;
  newLast30Days: number;
  /** Distinct customers with a meaningful action in the window, whatever their account status. */
  activeUsersLast30Days: number;
  windows: { last7DaysFrom: string; last30DaysFrom: string; timezone: string };
}

/**
 * The same figures as the ERPNext "E-commerce Users" workspace (erpnext/number-cards.json),
 * computed from the website database. Windows are calendar days in the site timezone, today
 * included. "Active users" counts customers whose last meaningful activity falls in the window.
 * That is not the same as an Active account status: a suspended customer may have been active
 * last week, and an Active account may have been idle for months.
 */
export async function computeUserStats(repo: CustomerRepository, timezone: string, now = new Date()): Promise<UserStats> {
  const since7 = windowStart(7, timezone, now);
  const since30 = windowStart(30, timezone, now);
  const [total, active, inactive, suspended, verified, new7, new30, recent] = await Promise.all([
    repo.count({}),
    repo.count({ accountStatus: 'active' }),
    repo.count({ accountStatus: 'inactive' }),
    repo.count({ accountStatus: 'suspended' }),
    repo.count({ emailVerified: true }),
    repo.count({ createdSince: since7 }),
    repo.count({ createdSince: since30 }),
    repo.count({ activeSince: since30 }),
  ]);
  return {
    totalRegistered: total,
    activeAccounts: active,
    inactiveAccounts: inactive,
    suspendedAccounts: suspended,
    emailVerified: verified,
    newLast7Days: new7,
    newLast30Days: new30,
    activeUsersLast30Days: recent,
    windows: { last7DaysFrom: formatInTimezone(since7, timezone), last30DaysFrom: formatInTimezone(since30, timezone), timezone },
  };
}
