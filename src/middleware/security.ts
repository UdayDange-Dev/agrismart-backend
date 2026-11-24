import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ipKeyGenerator, rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import type { RateLimitRule } from '../config/env.js';
import { forbidden } from '../lib/errors.js';
import { clientIp } from './originGate.js';

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Accepts a well-formed upstream request id (e.g. Nginx $request_id) or generates one. */
export function resolveRequestId(req: Request): string {
  const incoming = req.headers['x-request-id'];
  return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  // The standard Forwarded header (RFC 7239) is never used: the client IP comes from the socket or,
  // behind Nginx, from X-Forwarded-For with TRUST_PROXY=1. Drop any client-supplied value so no
  // later code can trust it (express-rate-limit also warns, ERR_ERL_FORWARDED_HEADER, when it sees one).
  delete req.headers.forwarded;
  res.locals.requestId = String(req.id ?? resolveRequestId(req));
  res.setHeader('X-Request-Id', res.locals.requestId);
  // API responses are private by default; public catalogue routes opt in to caching.
  res.setHeader('Cache-Control', 'no-store');
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF / cross-origin write protection for state-changing requests.
 *  - If an Origin header is present it must be allowlisted.
 *  - With `requireOrigin` (cookie-authenticated routes) a missing Origin is also rejected,
 *    so a forged cross-site form or a cookie replay without Origin cannot act as a user.
 */
export function originCheck(allowedOrigins: string[], opts: { requireOrigin: boolean }) {
  const allowed = new Set(allowedOrigins);
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.headers.origin;
    if (origin === undefined) {
      return next(opts.requireOrigin ? forbidden('Origin header required') : undefined);
    }
    if (!allowed.has(origin)) return next(forbidden('Origin not allowed'));
    next();
  };
}

export function limiter(rule: RateLimitRule, name: string): RateLimitRequestHandler {
  return rateLimit({
    windowMs: rule.windowMs,
    limit: rule.limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    identifier: name,
    // Key = visitor IP from the origin gate when the API runs behind the frontend proxy, otherwise
    // req.ip (correct only with an accurate `trust proxy`). IPv6 addresses are grouped by /56.
    keyGenerator: (req, res) => ipKeyGenerator(clientIp(req, res)),
    // Behind the origin gate X-Forwarded-For is expected and is read by clientIp() above, not via
    // `trust proxy`; the library's warning about an unexpected X-Forwarded-For does not apply.
    validate: { xForwardedForHeader: false },
    handler: (_req, res) => {
      res.status(429).json({
        error: { code: 'rate_limited', message: 'Too many requests, please try again later', requestId: res.locals.requestId },
      });
    },
  });
}
