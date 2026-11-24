/**
 * Local demo / browser-test stack: throwaway in-memory MongoDB + mock ERPNext (fixture data)
 * + the real API (same app, routes and middleware as production).
 *
 *   npm run dev:mock
 *   DEV_ADMIN_PASSWORD='Demo-Password-123' npm run dev:mock      # also creates a demo admin
 *
 * Extra switches used by the Playwright suite (Frontend/e2e):
 *   DEV_MAIL_OUTBOX=<file>        write account emails as JSON lines to <file> instead of the console
 *   DEV_CONTROL_PORT=<port>       start a 127.0.0.1-only control endpoint (expire tokens/sessions)
 *   DEV_CONTROL_SECRET=<secret>   required header value for the control endpoint
 *   DEV_RELAX_RATE_LIMITS=1       raise rate limits so a test run from one IP is not throttled
 *   APP_PUBLIC_URL=<origin>       origin used in email links (default http://127.0.0.1:5173)
 *
 * Account emails (see test/devMailer.ts): printed in this terminal and NOT sent, unless
 *   --smtp                        explicit opt-in: send through SMTP_* / MAIL_FROM (Backend/.env is
 *                                 loaded); connection and login are checked before the API starts,
 *                                 and all ERPNext writes (Lead and user-registry sync) are forced off.
 *                                 npm run dev:erp:smtp  =  npm run dev:erp -- --smtp
 *
 * Live ERPNext, local everything else (npm run dev:erp, i.e. --real-erp):
 *   uses ERPNEXT_* from Backend/.env (e.g. the production site) for real items, categories, prices
 *   and images, with the same throwaway in-memory MongoDB. Lead sync is forced OFF, so nothing is
 *   ever written to ERPNext: inquiries and E-commerce User profiles stay queued in the throwaway database.
 *
 * Never use this for production: all website data (accounts, orders, inquiries) is lost on exit.
 */
import dotenv from 'dotenv';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { buildServices, createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { connectMongo, isMongoReady } from '../src/db/mongo.js';
import { createLogger } from '../src/lib/logger.js';
import { createMongoRepositories, ensureMongoIndexes } from '../src/repositories/mongo/index.js';
import { passwordPolicy } from '../src/schemas/index.js';
import { hashPassword } from '../src/services/authService.js';
import { createDevMailer, DevMailError, selectDevMailMode, type DevMailMode } from './devMailer.js';
import { startStubErp, TEST_API_KEY, TEST_API_SECRET } from './helpers.js';

const realErp = process.argv.includes('--real-erp');
const label = realErp ? 'dev:erp' : 'dev:mock';
if (process.env.NODE_ENV === 'production') {
  console.error(`${label} must not run with NODE_ENV=production`);
  process.exit(1);
}

// Decide the mail mode first, so an unsafe combination stops before anything starts.
let mailMode: DevMailMode;
try {
  mailMode = selectDevMailMode(process.argv, process.env);
} catch (err) {
  console.error(`[${label}] ${(err as Error).message}`);
  process.exit(1);
}

/** ERPNext settings for --real-erp (and SMTP settings for --smtp) come from Backend/.env; values are never printed. */
const REQUIRED_ERP = ['ERPNEXT_BASE_URL', 'ERPNEXT_ALLOWED_HOSTS', 'ERPNEXT_API_KEY', 'ERPNEXT_API_SECRET'] as const;
if (realErp || mailMode === 'smtp') dotenv.config({ quiet: true });
if (realErp) {
  const missing = REQUIRED_ERP.filter((k) => !process.env[k]?.trim());
  if (missing.length > 0) {
    console.error(`[dev:erp] missing in Backend/.env: ${missing.join(', ')} (see Backend/.env.example)`);
    process.exit(1);
  }
}

/**
 * The throwaway database lives in <tmp>/agrismart-devstack/<pid>. If this process is killed
 * (e.g. by Playwright on Windows) it cannot clean up, so each start removes folders whose
 * owning process no longer exists. Folders of running stacks are never touched.
 */
const DB_ROOT = join(tmpdir(), 'agrismart-devstack');
mkdirSync(DB_ROOT, { recursive: true });
const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};
for (const name of readdirSync(DB_ROOT)) {
  const pid = Number(name);
  if (Number.isInteger(pid) && pid !== process.pid && !isRunning(pid)) rmSync(join(DB_ROOT, name), { recursive: true, force: true });
}
const dbPath = join(DB_ROOT, String(process.pid));
mkdirSync(dbPath, { recursive: true });
const mongo = await MongoMemoryServer.create({ instance: { dbPath } });
const erp = realErp ? null : await startStubErp();

Object.assign(process.env, {
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  PORT: process.env.PORT ?? '4000',
  MONGODB_URI: mongo.getUri('agrismart-dev'),
  ...(erp
    ? {
        ERPNEXT_BASE_URL: erp.url,
        ERPNEXT_ALLOWED_HOSTS: '127.0.0.1',
        ERPNEXT_API_KEY: TEST_API_KEY,
        ERPNEXT_API_SECRET: TEST_API_SECRET,
      }
    : // Live ERPNext: read-only. Overrides any ERPNEXT_LEAD_SYNC / ERPNEXT_USER_SYNC value from .env.
      { ERPNEXT_LEAD_SYNC: 'false', ERPNEXT_USER_SYNC: 'false' }),
  CORS_ALLOWED_ORIGINS: [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:4173',
    'http://127.0.0.1:4173',
    // Browser tests may serve the frontend on another port (E2E_WEB_PORT).
    ...(process.env.APP_PUBLIC_URL ? [new URL(process.env.APP_PUBLIC_URL).origin] : []),
  ].join(','),
  INQUIRY_SYNC_INTERVAL_SECONDS: '0',
});
// This stack never writes to a remote ERPNext: no approved write host, whatever .env says.
delete process.env.ERPNEXT_WRITE_APPROVED_HOST;
if (mailMode === 'smtp') Object.assign(process.env, { ERPNEXT_LEAD_SYNC: 'false', ERPNEXT_USER_SYNC: 'false' });

const config = loadConfig();
if (process.env.DEV_RELAX_RATE_LIMITS === '1') {
  for (const rule of Object.values(config.rateLimits)) rule.limit = 10_000;
}
const logger = createLogger(process.env.LOG_LEVEL ?? 'warn');

const outbox = process.env.DEV_MAIL_OUTBOX;
let devMail: Awaited<ReturnType<typeof createDevMailer>>;
try {
  devMail = await createDevMailer(mailMode, { config, logger, label, mailFromSet: Boolean(process.env.MAIL_FROM?.trim()), outbox });
} catch (err) {
  console.error(`[${label}] ${err instanceof DevMailError ? err.message : 'mail setup failed'}`);
  await erp?.close();
  await mongo.stop({ doCleanup: true, force: true });
  process.exit(1);
}
const mailer = devMail.mailer;

const connection = await connectMongo(config.mongodbUri, logger);
const repos = createMongoRepositories(connection);
try {
  await ensureMongoIndexes(connection);
} catch (err) {
  console.error(`[${label}] MongoDB could not build indexes: ${(err as Error).message}`);
  console.error(`[${label}] (MongoDB needs about 500 MB free on the drive holding ${DB_ROOT})`);
  process.exit(1);
}
const services = buildServices(config, logger, repos, { mailer });
const app = createApp({ config, logger, repos, services, isReady: isMongoReady });
const server = app.listen(config.port, config.host, (error?: Error) => {
  if (error) {
    console.error(`[${label}] cannot listen on ${config.host}:${config.port}: ${error.message} (is another dev server running?)`);
    process.exit(1);
  }
  console.log(
    `[${label}] API on http://${config.host}:${config.port} (in-memory MongoDB, ${erp ? 'mock ERPNext' : `LIVE ERPNext ${config.erpnext.baseUrl.host}, read-only, Lead sync OFF`})`,
  );
  console.log(`[${label}] ${devMail.description}`);
});

const adminPassword = process.env.DEV_ADMIN_PASSWORD;
if (adminPassword) {
  if (!passwordPolicy.safeParse(adminPassword).success) {
    console.error(`[${label}] DEV_ADMIN_PASSWORD does not meet the password policy; no admin created`);
  } else {
    await repos.users.create({ email: 'admin@agrismart.local', passwordHash: await hashPassword(adminPassword), role: 'admin' });
    console.log(`[${label}] demo admin created: admin@agrismart.local (password from DEV_ADMIN_PASSWORD)`);
  }
}

// Test-only control endpoint (time travel for expiry tests). Localhost only, secret required.
const controlPort = Number(process.env.DEV_CONTROL_PORT ?? 0);
const controlSecret = process.env.DEV_CONTROL_SECRET ?? '';
let control: ReturnType<typeof createServer> | null = null;
if (controlPort > 0 && controlSecret.length >= 16) {
  const past = () => new Date(Date.now() - 60_000);
  control = createServer(async (req, res) => {
    if (req.headers['x-dev-control'] !== controlSecret || req.method !== 'POST') {
      res.writeHead(403).end();
      return;
    }
    const db = mongoose.connection.db!;
    if (req.url === '/expire-tokens') await db.collection('customertokens').updateMany({}, { $set: { expiresAt: past() } });
    else if (req.url === '/expire-sessions') await db.collection('sessions').updateMany({ kind: 'customer' }, { $set: { expiresAt: past() } });
    else {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(204).end();
  });
  control.listen(controlPort, '127.0.0.1');
}

const stop = async () => {
  control?.close();
  server.close();
  await mongoose.disconnect().catch(() => undefined);
  await erp?.close();
  await mongo.stop({ doCleanup: true, force: true });
  rmSync(dbPath, { recursive: true, force: true });
  process.exit(0);
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
