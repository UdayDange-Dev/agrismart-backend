import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import type { Config } from './config/env.js';
import { ErpNextClient } from './integrations/erpnext/client.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { originGate } from './middleware/originGate.js';
import { limiter, originCheck, requestContext, resolveRequestId } from './middleware/security.js';
import type { Repositories } from './repositories/types.js';
import { adminRouter, authRouter } from './routes/admin.js';
import { customerRouter } from './routes/customer.js';
import { CustomerAuthService } from './services/customerAuthService.js';
import { ConsoleMailer, SmtpMailer, type Mailer } from './services/mailer.js';
import { SessionManager } from './services/sessionManager.js';
import { catalogRouter, commerceRouter, type ImageFetcher } from './routes/public.js';
import { AuthService } from './services/authService.js';
import { CatalogService, ErpNextCatalogSource, type CatalogSource } from './services/catalogService.js';
import { InquiryService } from './services/inquiryService.js';
import { ErpNextLeadGateway, type LeadGateway } from './services/leadSync.js';
import { OrderService } from './services/orderService.js';
import { checkRegistryAccess, ErpNextUserRegistry, RegistryMonitor, type RegistryAccessProblem, type UserRegistryGateway } from './services/userRegistry.js';

export interface Services {
  catalog: CatalogService;
  inquiries: InquiryService;
  orders: OrderService;
  auth: AuthService;
  customers: CustomerAuthService;
  sessions: SessionManager;
  mailer: Mailer;
  leadGateway: LeadGateway;
  userRegistry: UserRegistryGateway;
  /** Read-only check that the E-commerce User DocType exists and is accessible. */
  registryAccess: () => Promise<{ ok: true } | { ok: false; problem: RegistryAccessProblem }>;
  registryMonitor: RegistryMonitor;
  images: ImageFetcher;
}

function buildMailer(config: Config, logger: Logger): Mailer {
  if (config.mail.smtp) return new SmtpMailer(config.mail.smtp, config.mail.from);
  // Configuration validation guarantees SMTP in production; this branch is development only.
  if (config.isProduction) throw new Error('SMTP is required in production');
  return new ConsoleMailer(logger);
}

/** Wires services from configuration. Tests can override any dependency. */
export function buildServices(
  config: Config,
  logger: Logger,
  repos: Repositories,
  overrides: Partial<{ erp: ErpNextClient; catalogSource: CatalogSource; leadGateway: LeadGateway; userRegistry: UserRegistryGateway; mailer: Mailer }> = {},
): Services {
  const erp =
    overrides.erp ??
    new ErpNextClient({
      baseUrl: config.erpnext.baseUrl,
      apiKey: config.erpnext.apiKey,
      apiSecret: config.erpnext.apiSecret,
      timeoutMs: config.erpnext.timeoutMs,
      writes: config.erpnext.writes, // fail-closed write guard (writeGuard.ts)
      logger,
    });
  const source =
    overrides.catalogSource ??
    new ErpNextCatalogSource(
      erp,
      {
        priceList: config.erpnext.priceList,
        priceSync: config.erpnext.priceSync,
        catalogSource: config.erpnext.catalogSource,
        itemGroups: config.erpnext.itemGroups,
        timezone: config.erpnext.timezone,
      },
      logger,
    );
  const catalog = new CatalogService(source, config.catalog, logger);
  const leadGateway =
    overrides.leadGateway ??
    new ErpNextLeadGateway(erp, {
      leadSource: config.erpnext.leadSource,
      addComment: config.erpnext.leadAddComment,
      timezone: config.erpnext.timezone,
    });
  const sessions = new SessionManager(repos.sessions, { staff: config.session.staff, customer: config.session.customer });
  const mailer = overrides.mailer ?? buildMailer(config, logger);
  return {
    catalog,
    leadGateway,
    userRegistry: overrides.userRegistry ?? new ErpNextUserRegistry(erp),
    registryAccess: () => checkRegistryAccess(erp),
    registryMonitor: new RegistryMonitor(config.erpnext.userSync),
    images: erp,
    sessions,
    mailer,
    inquiries: new InquiryService(repos.inquiries, leadGateway, { timezone: config.erpnext.timezone, leadSync: config.erpnext.leadSync }, logger),
    orders: new OrderService(repos.orders, catalog, { priceList: config.erpnext.priceList }, logger),
    auth: new AuthService(repos.users, sessions),
    customers: new CustomerAuthService(repos.customers, repos.customerTokens, sessions, mailer, { publicUrl: config.publicUrl }, logger),
  };
}

export function createApp(deps: {
  config: Config;
  logger: Logger;
  repos: Repositories;
  services: Services;
  isReady: () => boolean;
}): Express {
  const { config, logger, repos, services } = deps;
  const app = express();

  app.disable('x-powered-by');
  // Number of trusted reverse-proxy hops (1 = Nginx on the same host). Never `true`,
  // which would let clients spoof X-Forwarded-For and bypass rate limits.
  app.set('trust proxy', config.trustProxy);
  app.set('query parser', 'simple');
  app.set('env', config.isProduction ? 'production' : 'development');

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => resolveRequestId(req as express.Request),
      // Log only safe request metadata: no headers, bodies or query strings.
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({ id: req.id, method: req.method, path: req.url.split('?')[0] }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req) => req.url === '/api/health' },
    }),
  );
  app.use(requestContext);
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      strictTransportSecurity: config.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
    }),
  );
  // Behind the frontend proxy: refuse anything that did not come through it (middleware/originGate.ts).
  app.use(
    originGate(config.originGate, (entries) =>
      // Deployment check without IPs: expect >= 1 (visitor first, then appended proxy hops).
      logger.info({ forwardedForEntries: entries }, 'Origin gate: first proxied request accepted'),
    ),
  );
  app.use(
    cors({
      // Only allowlisted origins get CORS headers; others are blocked by the browser
      // and state-changing requests from them are rejected by originCheck below.
      origin: (origin, cb) => cb(null, origin !== undefined && config.corsAllowedOrigins.includes(origin)),
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Idempotency-Key', 'X-Order-Token', 'X-Request-Id', 'X-CSRF-Token'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '16kb', strict: true, type: 'application/json' }));
  app.use(cookieParser());

  const api = express.Router();
  api.use(limiter(config.rateLimits.global, 'global'));

  api.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  api.get('/health/ready', (_req, res) => {
    const ready = deps.isReady();
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
  });

  api.use('/auth', authRouter({ config, auth: services.auth, logger }));
  api.use(
    '/admin',
    adminRouter({
      config,
      auth: services.auth,
      catalog: services.catalog,
      inquiryRepo: repos.inquiries,
      orderRepo: repos.orders,
      customerRepo: repos.customers,
      registryMonitor: services.registryMonitor,
      orders: services.orders,
      leadGateway: services.leadGateway,
      logger,
    }),
  );

  api.use('/customer', customerRouter({ config, customers: services.customers, orders: repos.orders, inquiries: repos.inquiries, logger }));

  api.use(originCheck(config.corsAllowedOrigins, { requireOrigin: false }));
  api.use(catalogRouter({ catalog: services.catalog, images: services.images, logger }));
  api.use(
    commerceRouter({
      config,
      catalog: services.catalog,
      inquiries: services.inquiries,
      orders: services.orders,
      customers: services.customers,
    }),
  );

  app.use('/api', api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
