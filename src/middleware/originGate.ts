import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { forbidden } from '../lib/errors.js';

/**
 * Origin gate for deployments behind the frontend host's proxy (Vercel rewrites /api/* to this
 * server and sets this header from a server-side environment variable; see the frontend's
 * vercel.json). The header is never sent by browsers and never reaches the client bundle.
 *
 *  - Every request must carry the shared secret, except the liveness/readiness probes that the
 *    hosting platform calls directly (they return only `{ status }`).
 *  - The header is removed after the check, so no later code, log or error can echo it.
 *  - Client IP: Vercel overwrites X-Forwarded-For with the visitor's address ("we currently
 *    overwrite the X-Forwarded-For header and do not forward external IPs"), and proxies after it
 *    only append. So for a request that proved it came through Vercel, the FIRST X-Forwarded-For
 *    entry is the visitor. Requests without the secret are refused before any rate limiter or
 *    route runs, so a forged X-Forwarded-For sent straight to this server never counts.
 */
export const ORIGIN_SECRET_HEADER = 'x-agrismart-origin-secret';

const PROBE_PATHS = new Set(['/api/health', '/api/health/ready']);

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/** Visitor IP taken from the first X-Forwarded-For entry, or undefined if absent or malformed. */
export function firstForwardedFor(req: Request): string | undefined {
  const raw = req.headers['x-forwarded-for'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const first = value?.split(',')[0]?.trim();
  return first && isIP(first) ? first : undefined;
}

export function originGate(gate: { secret: string } | null, onFirstProxiedRequest?: (forwardedEntries: number) => void) {
  const expected = gate ? digest(gate.secret) : null;
  let reported = false;
  return (req: Request, res: Response, next: NextFunction): void => {
    const presented = req.headers[ORIGIN_SECRET_HEADER];
    delete req.headers[ORIGIN_SECRET_HEADER];
    if (!expected) return next(); // no gate configured (development, tests)

    if ((req.method === 'GET' || req.method === 'HEAD') && PROBE_PATHS.has(req.path)) return next();

    // Compare fixed-length digests so neither content nor length leaks through timing.
    const ok = typeof presented === 'string' && presented.length > 0 && timingSafeEqual(digest(presented), expected);
    if (!ok) return next(forbidden('Forbidden'));

    res.locals.clientIp = firstForwardedFor(req);
    if (!reported && onFirstProxiedRequest) {
      reported = true;
      const xff = req.headers['x-forwarded-for'];
      onFirstProxiedRequest(typeof xff === 'string' ? xff.split(',').length : 0);
    }
    next();
  };
}

/** The client address used for rate limits and security logs. */
export function clientIp(req: Request, res: Response): string {
  return res.locals.clientIp ?? req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
