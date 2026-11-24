import { Router, type Response } from 'express';
import type { Logger } from 'pino';
import type { Config } from '../config/env.js';
import { notFound } from '../lib/errors.js';
import {
  cookieName,
  csrfProtect,
  loadCustomerSession,
  requireCustomer,
  requireVerifiedCustomer,
  sessionCookieOptions,
} from '../middleware/auth.js';
import { limiter, originCheck } from '../middleware/security.js';
import type { InquiryRepository, OrderRepository } from '../repositories/types.js';
import {
  addressBody,
  addressParams,
  changeEmailBody,
  changePasswordBody,
  customerInquiriesQuery,
  customerLoginBody,
  customerOrdersQuery,
  forgotPasswordBody,
  inquiryParams,
  orderParams,
  profileUpdateBody,
  registerBody,
  resetPasswordBody,
  tokenBody,
} from '../schemas/index.js';
import { MAX_ADDRESSES, toCustomerView, type CustomerAuthService } from '../services/customerAuthService.js';
import { toCustomerInquiryView } from '../services/inquiryService.js';
import { toCustomerView as toOrderView } from '../services/orderService.js';
import { csrfTokenFor } from '../services/sessionManager.js';

/**
 * Storefront customer accounts.
 *   /api/customer/auth/*     registration, sign in/out, verification, password recovery
 *   /api/customer/account/*  the signed-in customer's own profile (no ids in URLs)
 *   /api/customer/addresses/* the signed-in customer's address book
 *   /api/customer/inquiries/* the signed-in customer's own inquiries and quotation requests
 *   /api/customer/orders/*   the signed-in customer's own orders
 * Every route acts on `res.locals.customer` from the session. Ids in URLs (address ids, order and
 * inquiry references) are only ever looked up within that customer's own records, so one
 * customer cannot address another customer's data.
 */
export function customerRouter(deps: {
  config: Config;
  customers: CustomerAuthService;
  orders: OrderRepository;
  inquiries: InquiryRepository;
  logger: Logger;
}): Router {
  const { config, customers } = deps;
  const rl = config.rateLimits;
  const router = Router();
  const cookie = cookieName(config, 'customer');

  // Cookie-based API: Origin is mandatory on writes, and so is the session-bound CSRF token.
  router.use(originCheck(config.corsAllowedOrigins, { requireOrigin: true }));
  router.use(loadCustomerSession(config, customers));
  router.use(csrfProtect('customer'));

  const sessionPayload = (res: Response) => {
    const c = res.locals.customer;
    const token = res.locals.customerSessionToken;
    return { customer: c ? toCustomerView(c) : null, csrfToken: token ? csrfTokenFor(token) : null };
  };

  // ---------------------------------------------------------------- auth

  router.get('/auth/session', (_req, res) => {
    res.json(sessionPayload(res));
  });

  router.post('/auth/register', limiter(rl.register, 'register'), async (req, res) => {
    const { name, email, phone, password } = registerBody.parse(req.body);
    await customers.register({ name, email, phone, password });
    // Identical response whether or not the email was already registered.
    res.status(202).json({
      message: 'Thanks! If this email can be used for a new account, we have sent a confirmation link. Please check your inbox, then sign in.',
    });
  });

  router.post('/auth/login', limiter(rl.customerLogin, 'customer-login'), async (req, res) => {
    const { email, password } = customerLoginBody.parse(req.body);
    // Drop any session the browser already had, so a fixed/old session id is never reused.
    if (res.locals.customerSessionToken) await customers.logout(res.locals.customerSessionToken);
    const { token, customer, expiresAt } = await customers.login(email, password);
    res.cookie(cookie, token, sessionCookieOptions(config, expiresAt.getTime() - Date.now()));
    res.json({ customer: toCustomerView(customer), csrfToken: csrfTokenFor(token) });
  });

  router.post('/auth/logout', async (_req, res) => {
    if (res.locals.customerSessionToken) await customers.logout(res.locals.customerSessionToken);
    res.clearCookie(cookie, sessionCookieOptions(config));
    res.status(204).end();
  });

  router.post('/auth/verify-email', limiter(rl.tokenUse, 'token-use'), async (req, res) => {
    const { token } = tokenBody.parse(req.body);
    const result = await customers.confirmEmail(token);
    res.json({
      result,
      message: result === 'verified' ? 'Your email address is confirmed.' : 'Your email address has been updated.',
    });
  });

  router.post('/auth/resend-verification', limiter(rl.passwordReset, 'resend-verification'), requireCustomer, async (_req, res) => {
    await customers.resendVerification(res.locals.customer!.id);
    res.status(202).json({ message: 'If your email is not yet confirmed, a new link is on its way.' });
  });

  router.post('/auth/forgot-password', limiter(rl.passwordReset, 'forgot-password'), async (req, res) => {
    const { email } = forgotPasswordBody.parse(req.body);
    await customers.forgotPassword(email);
    res.status(202).json({ message: 'If an account exists for that email, we have sent a password reset link. It expires in 30 minutes.' });
  });

  router.post('/auth/reset-password', limiter(rl.tokenUse, 'token-use'), async (req, res) => {
    const { token, password } = resetPasswordBody.parse(req.body);
    await customers.resetPassword(token, password);
    // All sessions were revoked; clear this browser's cookie too.
    res.clearCookie(cookie, sessionCookieOptions(config));
    res.json({ message: 'Your password has been changed. Please sign in with your new password.' });
  });

  // ---------------------------------------------------------------- account (own data only)

  router.get('/account', requireCustomer, (_req, res) => {
    res.json(sessionPayload(res));
  });

  // Profile and address changes need a confirmed email. Password and email changes stay open to
  // unverified accounts, so a customer can secure the account or correct a mistyped address.
  router.patch('/account', limiter(rl.accountWrite, 'account-write'), requireVerifiedCustomer, async (req, res) => {
    const patch = profileUpdateBody.parse(req.body);
    const updated = await customers.updateProfile(res.locals.customer!.id, patch);
    res.json({ customer: toCustomerView(updated) });
  });

  router.post('/account/password', limiter(rl.accountWrite, 'account-write'), requireCustomer, async (req, res) => {
    const { currentPassword, newPassword } = changePasswordBody.parse(req.body);
    await customers.changePassword(res.locals.customer!.id, res.locals.customerSessionToken!, currentPassword, newPassword);
    res.json({ message: 'Your password has been changed. Other devices have been signed out.' });
  });

  router.post('/account/email', limiter(rl.accountWrite, 'account-write'), requireCustomer, async (req, res) => {
    const { currentPassword, newEmail } = changeEmailBody.parse(req.body);
    await customers.requestEmailChange(res.locals.customer!.id, currentPassword, newEmail);
    res.status(202).json({ message: 'We have sent a confirmation link to the new address. Your email changes once you click it.' });
  });

  // ---------------------------------------------------------------- address book (own addresses only)

  router.get('/addresses', requireVerifiedCustomer, async (_req, res) => {
    res.json({ items: await customers.listAddresses(res.locals.customer!.id), max: MAX_ADDRESSES });
  });

  router.post('/addresses', limiter(rl.accountWrite, 'account-write'), requireVerifiedCustomer, async (req, res) => {
    const address = await customers.addAddress(res.locals.customer!.id, addressBody.parse(req.body));
    res.status(201).json(address);
  });

  router.patch('/addresses/:id', limiter(rl.accountWrite, 'account-write'), requireVerifiedCustomer, async (req, res) => {
    const { id } = addressParams.parse(req.params);
    res.json(await customers.updateAddress(res.locals.customer!.id, id, addressBody.parse(req.body)));
  });

  router.delete('/addresses/:id', limiter(rl.accountWrite, 'account-write'), requireVerifiedCustomer, async (req, res) => {
    const { id } = addressParams.parse(req.params);
    await customers.deleteAddress(res.locals.customer!.id, id);
    res.status(204).end();
  });

  // ---------------------------------------------------------------- inquiries (own inquiries only)

  router.get('/inquiries', requireVerifiedCustomer, async (req, res) => {
    const q = customerInquiriesQuery.parse(req.query);
    const page = await deps.inquiries.list({ customerId: res.locals.customer!.id }, q.page, q.pageSize);
    res.json({ ...page, items: page.items.map(toCustomerInquiryView) });
  });

  router.get('/inquiries/:reference', requireVerifiedCustomer, async (req, res) => {
    const { reference } = inquiryParams.parse(req.params);
    const inquiry = await deps.inquiries.findByReference(reference);
    if (!inquiry || inquiry.customerId !== res.locals.customer!.id) throw notFound('Inquiry not found');
    res.json(toCustomerInquiryView(inquiry));
  });

  // ---------------------------------------------------------------- orders (own orders only)

  router.get('/orders', requireVerifiedCustomer, async (req, res) => {
    const q = customerOrdersQuery.parse(req.query);
    const page = await deps.orders.list({ customerId: res.locals.customer!.id }, q.page, q.pageSize);
    res.json({ ...page, items: page.items.map(toOrderView) });
  });

  router.get('/orders/:reference', requireVerifiedCustomer, async (req, res) => {
    const { reference } = orderParams.parse(req.params);
    const order = await deps.orders.findByReference(reference);
    // Same 404 for "does not exist" and "belongs to someone else" (no IDOR, no enumeration).
    if (!order || order.customerId !== res.locals.customer!.id) throw notFound('Order not found');
    res.json(toOrderView(order));
  });

  return router;
}
