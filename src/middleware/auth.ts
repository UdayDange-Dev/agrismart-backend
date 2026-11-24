import type { CookieOptions, NextFunction, Request, Response } from 'express';
import type { Config } from '../config/env.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import type { Role, SessionKind } from '../repositories/types.js';
import type { AuthService } from '../services/authService.js';
import type { CustomerAuthService } from '../services/customerAuthService.js';
import { verifyCsrfToken } from '../services/sessionManager.js';

export function sessionCookieOptions(config: Config, maxAgeMs?: number): CookieOptions {
  return {
    httpOnly: true,
    secure: config.session.secureCookie,
    sameSite: 'strict',
    path: '/',
    ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}),
  };
}

export const cookieName = (config: Config, kind: SessionKind) => config.session[kind].cookieName;

/** Resolves the staff session cookie into `res.locals.user`. Never throws for anonymous users. */
export function loadSession(config: Config, auth: AuthService) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token: unknown = req.cookies?.[cookieName(config, 'staff')];
    if (typeof token === 'string' && token.length > 0) {
      const user = await auth.authenticate(token);
      if (user) {
        res.locals.user = user;
        res.locals.sessionToken = token;
      }
    }
    next();
  };
}

/** Resolves the customer session cookie into `res.locals.customer`. Never throws for anonymous users. */
export function loadCustomerSession(config: Config, customers: CustomerAuthService) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token: unknown = req.cookies?.[cookieName(config, 'customer')];
    if (typeof token === 'string' && token.length > 0) {
      const customer = await customers.authenticate(token);
      if (customer) {
        res.locals.customer = customer;
        res.locals.customerSessionToken = token;
      }
    }
    next();
  };
}

export function requireAuth(_req: Request, res: Response, next: NextFunction): void {
  next(res.locals.user ? undefined : unauthorized());
}

/** Server-side role check. Must run after `requireAuth`. */
export function requireRole(...roles: Role[]) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const user = res.locals.user;
    if (!user) return next(unauthorized());
    next(roles.includes(user.role) ? undefined : forbidden());
  };
}

export function requireCustomer(_req: Request, res: Response, next: NextFunction): void {
  next(res.locals.customer ? undefined : unauthorized());
}

export function requireVerifiedCustomer(_req: Request, res: Response, next: NextFunction): void {
  if (!res.locals.customer) return next(unauthorized());
  next(
    res.locals.customer.emailVerified
      ? undefined
      : new AppError(403, 'email_unverified', 'Please verify your email address to use this feature.'),
  );
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection for cookie-authenticated, state-changing requests: the `X-CSRF-Token`
 * header must equal HMAC(session token). Applies only when the given session is present.
 * (Defence in depth on top of SameSite=Strict cookies and the Origin check.)
 */
export function csrfProtect(kind: SessionKind) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) return next();
    const token = kind === 'staff' ? res.locals.sessionToken : res.locals.customerSessionToken;
    if (!token) return next();
    if (verifyCsrfToken(token, req.headers['x-csrf-token'])) return next();
    next(new AppError(403, 'csrf_failed', 'Your session security token is missing or invalid. Please reload the page and try again.'));
  };
}
