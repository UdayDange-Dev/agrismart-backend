import { Router } from 'express';
import type { Logger } from 'pino';
import type { Config } from '../config/env.js';
import { conflict, notFound } from '../lib/errors.js';
import { cookieName, csrfProtect, loadSession, requireAuth, requireRole, sessionCookieOptions } from '../middleware/auth.js';
import { csrfTokenFor } from '../services/sessionManager.js';
import { limiter, originCheck } from '../middleware/security.js';
import { clientIp } from '../middleware/originGate.js';
import type { CustomerRepository, InquiryRecord, InquiryRepository, OrderRepository } from '../repositories/types.js';
import { adminInquiryQuery, adminOrderQuery, inquiryParams, loginBody, orderParams, orderStatusBody, registryRetryBody } from '../schemas/index.js';
import type { AuthService } from '../services/authService.js';
import type { CatalogService } from '../services/catalogService.js';
import { syncInquiry, type LeadGateway } from '../services/leadSync.js';
import type { OrderService } from '../services/orderService.js';
import { computeUserStats, type RegistryMonitor } from '../services/userRegistry.js';

export function authRouter(deps: { config: Config; auth: AuthService; logger: Logger }): Router {
  const router = Router();
  const { config, auth } = deps;
  // Cookie-authenticated routes: Origin header is mandatory for writes (CSRF defence with SameSite=Strict).
  const staffCookie = cookieName(config, 'staff');
  router.use(originCheck(config.corsAllowedOrigins, { requireOrigin: true }));
  router.use(loadSession(config, auth));
  router.use(csrfProtect('staff'));

  router.post('/login', limiter(config.rateLimits.login, 'login'), async (req, res) => {
    const { email, password } = loginBody.parse(req.body);
    if (res.locals.sessionToken) await auth.logout(res.locals.sessionToken); // never keep an old session id
    try {
      const { token, user, expiresAt } = await auth.login(email, password);
      res.cookie(staffCookie, token, sessionCookieOptions(config, expiresAt.getTime() - Date.now()));
      deps.logger.info({ userId: user.id, role: user.role }, 'Admin login succeeded');
      res.json({ user: { email: user.email, role: user.role }, csrfToken: csrfTokenFor(token) });
    } catch (err) {
      deps.logger.warn({ ip: clientIp(req, res) }, 'Admin login failed');
      throw err;
    }
  });

  router.post('/logout', async (_req, res) => {
    if (res.locals.sessionToken) await auth.logout(res.locals.sessionToken);
    res.clearCookie(staffCookie, sessionCookieOptions(config));
    res.status(204).end();
  });

  router.get('/me', requireAuth, (_req, res) => {
    res.json({
      user: { email: res.locals.user!.email, role: res.locals.user!.role },
      csrfToken: csrfTokenFor(res.locals.sessionToken!),
    });
  });

  return router;
}

const inquiryAdminView = (i: InquiryRecord) => ({
  reference: i.reference,
  kind: i.kind,
  name: i.name,
  email: i.email,
  phone: i.phone,
  company: i.company,
  productInterest: i.productInterest,
  quantity: i.quantity,
  message: i.message,
  syncStatus: i.syncStatus,
  erpLeadName: i.erpLeadName,
  attempts: i.attempts,
  lastErrorKind: i.lastErrorKind,
  createdAt: i.createdAt.toISOString(),
});

export function adminRouter(deps: {
  config: Config;
  auth: AuthService;
  catalog: CatalogService;
  inquiryRepo: InquiryRepository;
  orderRepo: OrderRepository;
  customerRepo: CustomerRepository;
  registryMonitor: RegistryMonitor;
  orders: OrderService;
  leadGateway: LeadGateway;
  logger: Logger;
}): Router {
  const router = Router();
  // Deny by default: every admin route requires a staff session; customer sessions are a
  // different cookie and session kind and are never accepted here.
  router.use(originCheck(deps.config.corsAllowedOrigins, { requireOrigin: true }));
  router.use(loadSession(deps.config, deps.auth));
  router.use(requireAuth);
  router.use(csrfProtect('staff'));

  // Read access: staff and admins.
  router.get('/inquiries', requireRole('admin', 'staff'), async (req, res) => {
    const q = adminInquiryQuery.parse(req.query);
    const page = await deps.inquiryRepo.list({ syncStatus: q.status }, q.page, q.pageSize);
    deps.logger.info({ userId: res.locals.user!.id, count: page.items.length }, 'Admin viewed inquiries');
    res.json({ ...page, items: page.items.map(inquiryAdminView) });
  });

  router.get('/orders', requireRole('admin', 'staff'), async (req, res) => {
    const q = adminOrderQuery.parse(req.query);
    const page = await deps.orderRepo.list({ status: q.status }, q.page, q.pageSize);
    deps.logger.info({ userId: res.locals.user!.id, count: page.items.length }, 'Admin viewed orders');
    res.json({
      ...page,
      items: page.items.map(({ accessTokenHash: _a, idempotencyKeyHash: _i, id: _id, ...o }) => ({
        ...o,
        createdAt: o.createdAt.toISOString(),
        updatedAt: o.updatedAt.toISOString(),
      })),
    });
  });

  // Registered / active user figures, computed like the ERPNext "E-commerce Users" workspace.
  // Aggregates only: no customer records are returned.
  router.get('/customers/stats', requireRole('admin', 'staff'), async (_req, res) => {
    res.json(await computeUserStats(deps.customerRepo, deps.config.erpnext.timezone));
  });

  // ERPNext user registry sync health: aggregate counts and safe error categories only.
  router.get('/customers/registry-health', requireRole('admin', 'staff'), async (_req, res) => {
    const now = new Date();
    const h = await deps.customerRepo.registryHealth(now);
    res.json({
      enabled: deps.config.erpnext.userSync,
      job: deps.registryMonitor.snapshot(),
      queue: {
        ...h,
        oldestPendingSince: h.oldestPendingSince?.toISOString() ?? null,
        oldestPendingAgeSeconds: h.oldestPendingSince ? Math.round((now.getTime() - h.oldestPendingSince.getTime()) / 1000) : null,
        lastSuccessAt: h.lastSuccessAt?.toISOString() ?? null,
      },
    });
  });

  // Write access: admins only.
  router.patch('/orders/:reference/status', requireRole('admin'), async (req, res) => {
    const { reference } = orderParams.parse(req.params);
    const { status } = orderStatusBody.parse(req.body);
    const order = await deps.orders.transition(reference, status);
    deps.logger.info({ userId: res.locals.user!.id, order: reference, status }, 'Order status changed');
    res.json({ reference: order.reference, status: order.status });
  });

  router.post('/inquiries/:reference/retry-sync', requireRole('admin'), async (req, res) => {
    const { reference } = inquiryParams.parse(req.params);
    if (!deps.config.erpnext.leadSync) throw conflict('ERPNext Lead sync is disabled on this server (ERPNEXT_LEAD_SYNC=false)');
    const inquiry = await deps.inquiryRepo.findByReference(reference);
    if (!inquiry) throw notFound('Inquiry not found');
    if (inquiry.syncStatus === 'failed') {
      await deps.inquiryRepo.updateSync(inquiry.id, { syncStatus: 'pending', attempts: 0, nextAttemptAt: new Date() });
    }
    const result = await syncInquiry(deps.inquiryRepo, deps.leadGateway, inquiry.id, deps.logger);
    res.json({ reference, result });
  });

  // Operator retry of failed registry syncs, after the cause has been fixed (admins only).
  router.post('/customers/registry-sync/retry', requireRole('admin'), async (req, res) => {
    const { scope, customerId } = registryRetryBody.parse(req.body ?? {});
    const requeued = await deps.customerRepo.retryFailedRegistrySync(new Date(), scope, customerId);
    deps.logger.info({ userId: res.locals.user!.id, scope, requeued }, 'Registry sync retry requested');
    res.json({ requeued });
  });

  router.post('/catalog/refresh', requireRole('admin'), async (_req, res) => {
    deps.catalog.invalidate();
    const catalog = await deps.catalog.getCatalog();
    res.json({ products: catalog.products.length, loadedAt: new Date(catalog.loadedAt).toISOString() });
  });

  return router;
}
