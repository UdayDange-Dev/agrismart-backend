import dotenv from 'dotenv';
import { buildServices, createApp } from './app.js';
import { ConfigError, loadConfig } from './config/env.js';
import { connectMongo, disconnectMongo, isMongoReady } from './db/mongo.js';
import { startInquirySyncJob } from './jobs/inquirySync.js';
import { createLogger } from './lib/logger.js';
import { createMongoRepositories, ensureMongoIndexes } from './repositories/mongo/index.js';
import { describe } from './services/catalogService.js';
import { DEFINITIVE_ACCESS_PROBLEMS, startUserRegistryJob } from './services/userRegistry.js';

dotenv.config({ quiet: true });

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Variable names and rules only; values are never printed.
      console.error(`[agrismart-api] Refusing to start. Configuration problems:\n - ${err.problems.join('\n - ')}`);
      if (process.env.NODE_ENV !== 'production') {
        console.error(
          '[agrismart-api] Copy .env.example to .env and fill in MongoDB and ERPNext (test site) values,\n' +
            "                or run 'npm run dev:mock' for a local stack with in-memory MongoDB and mock ERPNext.",
        );
      }
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config.logLevel);
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: describe(reason) }, 'Unhandled promise rejection; exiting');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: { name: err.name, message: err.message, stack: err.stack } }, 'Uncaught exception; exiting');
    process.exit(1);
  });

  const connection = await connectMongo(config.mongodbUri, logger);
  const repos = createMongoRepositories(connection);
  try {
    await ensureMongoIndexes(connection);
  } catch (err) {
    // Refuse to serve without the unique indexes that prevent duplicate accounts and orders.
    logger.fatal({ err: describe(err) }, 'MongoDB indexes could not be built; refusing to start');
    process.exit(1);
  }
  const services = buildServices(config, logger, repos);
  // Which mailer account emails use (host and mode only; never credentials).
  const smtp = config.mail.smtp;
  if (smtp) logger.info({ host: smtp.host, port: smtp.port, tls: smtp.secure ? 'implicit' : 'starttls' }, 'Outgoing email: SMTP');
  else logger.warn('Outgoing email: NOT SENT (no SMTP_HOST): account emails are printed to the console (development only)');
  const app = createApp({ config, logger, repos, services, isReady: isMongoReady });

  // Express 5 passes listen errors (e.g. EADDRINUSE) to this callback instead of throwing.
  const server = app.listen(config.port, config.host, (error?: Error) => {
    if (error) {
      logger.fatal({ err: { name: error.name, message: error.message }, host: config.host, port: config.port }, 'Cannot listen; exiting');
      process.exit(1);
    }
    logger.info({ host: config.host, port: config.port, env: config.env }, 'Agrismart API listening');
  });
  // Bound slow clients (slowloris) and idle sockets. Nginx sits in front with its own limits.
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1000;

  // Lead sync off (ERPNEXT_LEAD_SYNC=false): the API never writes to ERPNext, so no retry job either.
  const stopJob = config.erpnext.leadSync
    ? startInquirySyncJob(repos.inquiries, services.leadGateway, config.inquirySyncIntervalMs, logger)
    : () => undefined;
  if (!config.erpnext.leadSync) {
    logger.warn('ERPNext Lead sync is disabled (ERPNEXT_LEAD_SYNC=false): inquiries are stored locally and not sent to ERPNext');
  }

  // E-commerce User registry (ERPNEXT_USER_SYNC). While off, profile changes stay queued in MongoDB.
  // Before enabling it, check (read-only) that the DocType exists and is accessible. A definitive
  // problem (missing DocType, credentials, permissions) stops the server with a clear message; an
  // unreachable ERPNext does not keep the website down, the job keeps checking instead.
  if (config.erpnext.userSync) {
    const access = await services.registryAccess();
    services.registryMonitor.recordCheck(access, new Date());
    if (!access.ok && DEFINITIVE_ACCESS_PROBLEMS.has(access.problem)) {
      logger.fatal(
        { problem: access.problem },
        'ERPNEXT_USER_SYNC=true but the ERPNext "E-commerce User" DocType is not usable; set up erpnext first or set ERPNEXT_USER_SYNC=false. Refusing to start',
      );
      process.exit(1);
    }
    if (!access.ok) logger.warn({ problem: access.problem }, 'ERPNext user registry check failed; sync will start once ERPNext is reachable');
  }
  const stopUserJob = config.erpnext.userSync
    ? startUserRegistryJob(
        repos.customers,
        services.userRegistry,
        services.registryAccess,
        services.registryMonitor,
        { timezone: config.erpnext.timezone, intervalMs: config.inquirySyncIntervalMs },
        logger,
      )
    : () => undefined;
  if (!config.erpnext.userSync) logger.info('ERPNext user registry sync is off (ERPNEXT_USER_SYNC=false)');

  // Warm the catalogue so configuration problems (e.g. missing price list) surface in logs early.
  services.catalog.getCatalog().catch(() => undefined);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    stopJob();
    stopUserJob();
    const force = setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10_000);
    force.unref();
    server.close(async () => {
      await disconnectMongo().catch(() => undefined);
      logger.info('Shutdown complete');
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('[agrismart-api] Fatal startup error:', err instanceof Error ? err.name + ': ' + err.message : 'unknown');
  process.exit(1);
});
