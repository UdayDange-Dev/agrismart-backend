/**
 * Staff tools for website customer accounts and the ERPNext E-commerce User registry. Runs on the
 * server only (needs MONGODB_URI); there is deliberately no browser or API route to change status.
 * Output contains customer ids and error categories only, never emails, phone numbers or data.
 *
 *   npm run user-registry -- status --email farmer@example.com --set suspended   # active|inactive|suspended
 *   npm run user-registry -- health                 # sync queue: pending, failed, oldest, last success
 *   npm run user-registry -- failed                 # failed syncs: customer id, failure, error category
 *   npm run user-registry -- retry --scope failed   # permanent|exhausted|failed (both)
 *   npm run user-registry -- retry --customer <id>  # one customer, after fixing the cause
 *   npm run user-registry -- stats                  # the same figures as the ERPNext workspace
 *   npm run user-registry -- mobile-report          # read-only: invalid / shared mobile numbers (counts)
 *
 * Suspending or deactivating an account ends all its sessions at once; the change reaches ERPNext
 * with the next registry sync (ERPNEXT_USER_SYNC=true).
 */
import dotenv from 'dotenv';
import { connectMongo, disconnectMongo } from '../db/mongo.js';
import { createLogger } from '../lib/logger.js';
import { createMongoRepositories } from '../repositories/mongo/index.js';
import { ACCOUNT_STATUSES, type AccountStatus, type RegistryRetryScope } from '../repositories/types.js';
import { email as emailSchema, normalizeMobile } from '../schemas/index.js';
import { computeUserStats } from '../services/userRegistry.js';

dotenv.config({ quiet: true });

const COMMANDS = ['status', 'health', 'failed', 'retry', 'stats', 'mobile-report'] as const;
const SCOPES: RegistryRetryScope[] = ['failed', 'permanent', 'exhausted'];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const command = process.argv[2] as (typeof COMMANDS)[number];
  if (!COMMANDS.includes(command)) {
    console.error(`Usage: user-registry ${COMMANDS.join(' | ')} (see the header of src/scripts/userRegistry.ts)`);
    return 1;
  }
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  const logger = createLogger('warn');
  const conn = await connectMongo(uri, logger);
  const repos = createMongoRepositories(conn);
  const now = new Date();
  try {
    switch (command) {
      case 'status': {
        const email = emailSchema.parse(arg('email'));
        const status = arg('set') as AccountStatus;
        if (!ACCOUNT_STATUSES.includes(status)) throw new Error(`--set must be one of: ${ACCOUNT_STATUSES.join(', ')}`);
        const customer = await repos.customers.findByEmail(email);
        if (!customer) throw new Error('No customer with that email');
        await repos.customers.setAccountStatus(customer.id, status, now);
        if (status !== 'active') await repos.sessions.deleteBySubject('customer', customer.id);
        console.log(`Account ${customer.id} is now ${status}${status !== 'active' ? '; its sessions were ended' : ''}.`);
        break;
      }
      case 'health': {
        const h = await repos.customers.registryHealth(now);
        console.log(
          JSON.stringify(
            {
              ...h,
              oldestPendingAgeSeconds: h.oldestPendingSince ? Math.round((now.getTime() - h.oldestPendingSince.getTime()) / 1000) : null,
            },
            null,
            2,
          ),
        );
        break;
      }
      case 'failed': {
        for (const row of await repos.customers.listRegistryFailures(200)) {
          console.log(
            `${row.customerId}  ${row.failure.padEnd(9)}  ${String(row.lastErrorKind).padEnd(16)}  attempts=${row.attempts}  lastError=${row.lastErrorAt?.toISOString() ?? '-'}`,
          );
        }
        break;
      }
      case 'retry': {
        const scope = (arg('scope') ?? 'failed') as RegistryRetryScope;
        if (!SCOPES.includes(scope)) throw new Error(`--scope must be one of: ${SCOPES.join(', ')}`);
        const customer = arg('customer');
        const n = await repos.customers.retryFailedRegistrySync(now, scope, customer);
        console.log(`Re-queued ${n} failed registry sync(s)${customer ? ' for that customer' : ''}. Fix the cause first (see "failed").`);
        break;
      }
      case 'stats':
        console.log(JSON.stringify(await computeUserStats(repos.customers, process.env.ERPNEXT_TIMEZONE || 'Asia/Kolkata', now), null, 2));
        break;
      case 'mobile-report': {
        // Read-only preflight for a possible "one account per mobile" rule (not enabled).
        const rows = await conn.collection('customers').find({}, { projection: { phone: 1 } }).toArray();
        const byNumber = new Map<string, string[]>();
        let invalid = 0;
        const invalidIds: string[] = [];
        for (const r of rows) {
          const e164 = normalizeMobile(typeof r.phone === 'string' ? r.phone : '');
          if (!e164) {
            invalid += 1;
            if (invalidIds.length < 50) invalidIds.push(String(r._id));
            continue;
          }
          byNumber.set(e164, [...(byNumber.get(e164) ?? []), String(r._id)]);
        }
        const shared = [...byNumber.values()].filter((ids) => ids.length > 1);
        console.log(
          JSON.stringify(
            {
              customers: rows.length,
              invalidNumbers: invalid,
              invalidSampleIds: invalidIds,
              numbersSharedByMoreThanOneAccount: shared.length,
              accountsSharingANumber: shared.reduce((n, ids) => n + ids.length, 0),
              // Ids only (never the numbers); at most 50 groups.
              sharedGroups: shared.slice(0, 50),
            },
            null,
            2,
          ),
        );
        break;
      }
    }
    return 0;
  } finally {
    await disconnectMongo().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error('user-registry failed:', err instanceof Error ? err.message : 'unknown error');
    process.exit(1);
  },
);
