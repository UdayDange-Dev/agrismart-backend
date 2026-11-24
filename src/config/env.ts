import { erpnextWritePolicy, isProductionHost, isTestRuntime, type WritePolicy } from '../integrations/erpnext/writeGuard.js';
import { z } from 'zod';

/**
 * Configuration is validated once at startup. Errors list variable names only,
 * never their values, so secrets cannot leak into logs.
 */

const PLACEHOLDER_PATTERN = /^(replace[-_ ]?me|changeme|change[-_]me|your[-_].*|xxx+|placeholder|example|todo)$/i;

const csv = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

const secret = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .min(8, `${name} is too short`)
    .refine((v) => !PLACEHOLDER_PATTERN.test(v), `${name} still contains a placeholder value`);

const boolFromEnv = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === 'true' || v === '1'));

const intFromEnv = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return fallback;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `must be an integer between ${min} and ${max}` });
        return z.NEVER;
      }
      return n;
    });

const rawSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: intFromEnv(4000, 1, 65535),
  TRUST_PROXY: intFromEnv(0, 0, 5),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  /**
   * Shared secret that the frontend host (Vercel) adds to every proxied /api request in the
   * ORIGIN_SECRET_HEADER header. Required in production: requests that reach this server directly
   * (without the secret) are refused, so the API is reachable only through the frontend proxy.
   */
  ORIGIN_SHARED_SECRET: z.string().optional(),

  MONGODB_URI: z
    .string({ error: 'MONGODB_URI is required' })
    .regex(/^mongodb(\+srv)?:\/\//, 'MONGODB_URI must be a mongodb:// or mongodb+srv:// URI'),

  ERPNEXT_BASE_URL: z.string({ error: 'ERPNEXT_BASE_URL is required' }),
  ERPNEXT_ALLOWED_HOSTS: z.string({ error: 'ERPNEXT_ALLOWED_HOSTS is required' }),
  ERPNEXT_API_KEY: secret('ERPNEXT_API_KEY'),
  ERPNEXT_API_SECRET: secret('ERPNEXT_API_SECRET'),
  ERPNEXT_PRICE_LIST: z.string().min(1).max(140).default('MRP'),
  /** false = no Item Price / Price List access: every product is shown without a price ("Ask for price"). */
  ERPNEXT_PRICE_SYNC: boolFromEnv(true),
  ERPNEXT_CATALOG_SOURCE: z.enum(['website_item', 'item']).default('website_item'),
  ERPNEXT_ITEM_GROUPS: z.string().optional(),
  ERPNEXT_TIMEOUT_MS: intFromEnv(8000, 1000, 60000),
  ERPNEXT_TIMEZONE: z.string().default('Asia/Kolkata'),
  ERPNEXT_LEAD_SOURCE: z.string().max(140).optional(),
  ERPNEXT_LEAD_ADD_COMMENT: boolFromEnv(true),
  /** false = inquiries are stored and queued but never written to ERPNext (read-only testing). */
  ERPNEXT_LEAD_SYNC: boolFromEnv(true),
  /**
   * true = copy customer profiles to the ERPNext "E-commerce User" registry (custom DocType, see
   * erpnext). Off by default: turn on only after the DocType and role exist on the site.
   * While off, changes are queued locally and backfilled once it is switched on.
   */
  ERPNEXT_USER_SYNC: boolFromEnv(false),
  /**
   * Exact hostname of the ERPNext site this server may write to (Leads, Comments, E-commerce User).
   * Required for any write to a non-local site; for the production site also NODE_ENV=production.
   * See src/integrations/erpnext/writeGuard.ts.
   */
  ERPNEXT_WRITE_APPROVED_HOST: z.string().max(253).optional(),

  CATALOG_CACHE_TTL_SECONDS: intFromEnv(300, 10, 86400),
  CATALOG_MAX_STALE_SECONDS: intFromEnv(3600, 0, 604800),
  INQUIRY_SYNC_INTERVAL_SECONDS: intFromEnv(60, 0, 86400),
  SESSION_TTL_HOURS: intFromEnv(8, 1, 168),
  STAFF_SESSION_IDLE_MINUTES: intFromEnv(30, 5, 1440),
  CUSTOMER_SESSION_TTL_HOURS: intFromEnv(168, 1, 720),
  CUSTOMER_SESSION_IDLE_HOURS: intFromEnv(24, 1, 720),

  /** Public storefront URL used to build links in emails (verification, password reset). */
  APP_PUBLIC_URL: z.string().optional(),
  MAIL_FROM: z.string().max(200).optional(),
  SMTP_HOST: z.string().max(253).optional(),
  SMTP_PORT: intFromEnv(587, 1, 65535),
  /** true = implicit TLS (port 465). false = STARTTLS, which is then required. */
  SMTP_SECURE: boolFromEnv(false),
  SMTP_USER: z.string().max(254).optional(),
  SMTP_PASS: z.string().max(512).optional(),
});

export interface RateLimitRule {
  windowMs: number;
  limit: number;
}

export interface Config {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  host: string;
  port: number;
  trustProxy: number;
  logLevel: string;
  corsAllowedOrigins: string[];
  /**
   * Set when the API runs behind a proxy that proves itself with a shared secret header
   * (middleware/originGate.ts). null = no gate (development and tests only).
   */
  originGate: { secret: string } | null;
  mongodbUri: string;
  erpnext: {
    baseUrl: URL;
    apiKey: string;
    apiSecret: string;
    priceList: string;
    /** When false, prices are not read from ERPNext at all and every product has price null. */
    priceSync: boolean;
    catalogSource: 'website_item' | 'item';
    itemGroups: string[];
    timeoutMs: number;
    timezone: string;
    leadSource: string | undefined;
    leadAddComment: boolean;
    /** When false, nothing is written to ERPNext: inquiries stay queued locally. */
    leadSync: boolean;
    /** When false, customer profiles are not written to the ERPNext E-commerce User registry. */
    userSync: boolean;
    /** Whether this runtime may write to the configured ERPNext site at all (fail closed). */
    writes: WritePolicy;
  };
  catalog: { ttlMs: number; maxStaleMs: number };
  inquirySyncIntervalMs: number;
  publicUrl: URL;
  mail: {
    from: string;
    smtp: { host: string; port: number; secure: boolean; user: string | undefined; pass: string | undefined } | null;
  };
  session: {
    secureCookie: boolean;
    staff: SessionPolicy;
    customer: SessionPolicy;
  };
  rateLimits: {
    global: RateLimitRule;
    inquiries: RateLimitRule;
    orders: RateLimitRule;
    cartQuote: RateLimitRule;
    login: RateLimitRule;
    customerLogin: RateLimitRule;
    register: RateLimitRule;
    passwordReset: RateLimitRule;
    tokenUse: RateLimitRule;
    accountWrite: RateLimitRule;
  };
}

export interface SessionPolicy {
  cookieName: string;
  /** Absolute lifetime from sign-in. */
  ttlMs: number;
  /** Session ends after this much inactivity. */
  idleMs: number;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
  }
}

function parseOrigin(value: string, isProduction: boolean, problems: string[]): string | null {
  try {
    const url = new URL(value);
    if (url.origin !== value.replace(/\/$/, '')) {
      problems.push('CORS_ALLOWED_ORIGINS entries must be bare origins (scheme://host[:port])');
      return null;
    }
    if (isProduction && url.protocol !== 'https:') {
      problems.push('CORS_ALLOWED_ORIGINS must use https in production');
      return null;
    }
    return url.origin;
  } catch {
    problems.push('CORS_ALLOWED_ORIGINS contains an invalid URL');
    return null;
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = rawSchema.safeParse(source);
  if (!parsed.success) {
    // Only report variable names and rule messages, never values.
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`));
  }
  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';
  const problems: string[] = [];

  // ERPNext base URL: strict parsing + host allowlist to prevent SSRF via configuration.
  let baseUrl: URL | null = null;
  try {
    baseUrl = new URL(env.ERPNEXT_BASE_URL);
  } catch {
    problems.push('ERPNEXT_BASE_URL is not a valid URL');
  }
  const allowedHosts = csv(env.ERPNEXT_ALLOWED_HOSTS).map((h) => h.toLowerCase());
  if (allowedHosts.length === 0) problems.push('ERPNEXT_ALLOWED_HOSTS must list at least one host');
  if (baseUrl) {
    if (!['https:', 'http:'].includes(baseUrl.protocol)) problems.push('ERPNEXT_BASE_URL must be http(s)');
    if (isProduction && baseUrl.protocol !== 'https:') problems.push('ERPNEXT_BASE_URL must use https in production');
    if (baseUrl.username || baseUrl.password) problems.push('ERPNEXT_BASE_URL must not embed credentials');
    if (baseUrl.search || baseUrl.hash) problems.push('ERPNEXT_BASE_URL must not contain a query or fragment');
    if (baseUrl.pathname !== '/') problems.push('ERPNEXT_BASE_URL must be the site root');
    if (!allowedHosts.includes(baseUrl.hostname.toLowerCase())) {
      problems.push('ERPNEXT_BASE_URL host is not in ERPNEXT_ALLOWED_HOSTS');
    }
  }

  // ERPNext write guard. Ambiguous settings are rejected rather than interpreted.
  let writes: WritePolicy = { allowed: false, reason: 'ERPNext URL is invalid' };
  const approvedHost = env.ERPNEXT_WRITE_APPROVED_HOST?.trim() || undefined;
  if (approvedHost !== undefined) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(approvedHost)) {
      problems.push('ERPNEXT_WRITE_APPROVED_HOST must be a bare lower-case hostname (no scheme, port, path or wildcard)');
    } else if (baseUrl && approvedHost !== baseUrl.hostname) {
      problems.push('ERPNEXT_WRITE_APPROVED_HOST does not match the ERPNEXT_BASE_URL host');
    } else if (baseUrl && isProductionHost(approvedHost) && !isProduction) {
      problems.push('ERPNEXT_WRITE_APPROVED_HOST may name the production ERPNext site only with NODE_ENV=production');
    }
  }
  if (baseUrl) {
    writes = erpnextWritePolicy({ env: env.NODE_ENV, baseUrl, approvedHost, testRuntime: isTestRuntime(source) });
    // Fail closed: a sync that would write must not start against a site it may not write to.
    if ((env.ERPNEXT_LEAD_SYNC || env.ERPNEXT_USER_SYNC) && !writes.allowed) {
      problems.push(
        `ERPNext writes are not allowed here (${writes.reason}). Set ERPNEXT_LEAD_SYNC=false and ERPNEXT_USER_SYNC=false, ` +
          'or point ERPNEXT_BASE_URL at an approved non-production site',
      );
    }
  }

  // Website prices must come from a deliberately chosen price list, never an assumed default.
  if (isProduction && env.ERPNEXT_PRICE_SYNC && !source.ERPNEXT_PRICE_LIST?.trim()) {
    problems.push('ERPNEXT_PRICE_LIST must be set explicitly in production (the ERPNext selling price list for website prices)');
  }

  const origins = csv(env.CORS_ALLOWED_ORIGINS)
    .map((o) => parseOrigin(o, isProduction, problems))
    .filter((o): o is string => o !== null);
  if (isProduction && origins.length === 0) {
    problems.push('CORS_ALLOWED_ORIGINS is required in production');
  }

  // Origin gate: only the frontend proxy, which knows this secret, may reach the API.
  const originSecret = env.ORIGIN_SHARED_SECRET?.trim() || undefined;
  if (originSecret !== undefined) {
    if (originSecret.length < 32 || originSecret.length > 256) {
      problems.push('ORIGIN_SHARED_SECRET must be 32 to 256 characters');
    } else if (!/^[A-Za-z0-9._~+/=-]+$/.test(originSecret)) {
      // Also rejects an unexpanded "$ORIGIN_SECRET" copied from vercel.json.
      problems.push('ORIGIN_SHARED_SECRET may only contain letters, digits and ._~+/=-');
    } else if (PLACEHOLDER_PATTERN.test(originSecret)) {
      problems.push('ORIGIN_SHARED_SECRET still contains a placeholder value');
    }
  } else if (isProduction) {
    problems.push('ORIGIN_SHARED_SECRET is required in production (the API must only be reachable through the frontend proxy)');
  }

  let publicUrl: URL | null = null;
  const rawPublicUrl = env.APP_PUBLIC_URL ?? (isProduction ? undefined : 'http://127.0.0.1:5173');
  if (!rawPublicUrl) {
    problems.push('APP_PUBLIC_URL is required in production');
  } else {
    try {
      publicUrl = new URL(rawPublicUrl);
      if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username) {
        problems.push('APP_PUBLIC_URL must be a bare origin (scheme://host[:port])');
      }
      if (isProduction && publicUrl.protocol !== 'https:') problems.push('APP_PUBLIC_URL must use https in production');
    } catch {
      problems.push('APP_PUBLIC_URL is not a valid URL');
    }
  }

  // Customer accounts depend on email (verification, password reset), so production needs SMTP.
  let smtp: Config['mail']['smtp'] = null;
  if (env.SMTP_HOST) {
    smtp = { host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE, user: env.SMTP_USER, pass: env.SMTP_PASS };
    const localRelay = /^(localhost|127\.0\.0\.1|::1)$/i.test(env.SMTP_HOST);
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(env.SMTP_HOST) && !localRelay) problems.push('SMTP_HOST must be a hostname');
    if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASS)) problems.push('SMTP_USER and SMTP_PASS must be set together');
    // Common misconfigurations that otherwise only fail when the first email is sent.
    if (env.SMTP_PORT === 465 && !env.SMTP_SECURE) problems.push('SMTP_PORT 465 requires SMTP_SECURE=true (implicit TLS)');
    if ((env.SMTP_PORT === 587 || env.SMTP_PORT === 25) && env.SMTP_SECURE) {
      problems.push(`SMTP_PORT ${env.SMTP_PORT} uses STARTTLS; set SMTP_SECURE=false`);
    }
    if (isProduction && !localRelay && !env.SMTP_USER) {
      problems.push('SMTP_USER and SMTP_PASS are required in production for a remote SMTP server');
    }
  } else if (isProduction) {
    problems.push('SMTP_HOST is required in production (customer verification and password-reset emails)');
  }
  if (isProduction && !env.MAIL_FROM) problems.push('MAIL_FROM is required in production');
  if (env.MAIL_FROM && !/^[^\r\n<>]*<?[^\s@<>]+@[^\s@<>]+>?$/.test(env.MAIL_FROM)) {
    problems.push('MAIL_FROM must be an email address, optionally with a display name');
  }

  if (problems.length > 0 || !baseUrl || !publicUrl) throw new ConfigError(problems);

  return {
    env: env.NODE_ENV,
    isProduction,
    host: env.HOST,
    port: env.PORT,
    trustProxy: env.TRUST_PROXY,
    logLevel: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
    corsAllowedOrigins: origins,
    originGate: originSecret ? { secret: originSecret } : null,
    mongodbUri: env.MONGODB_URI,
    erpnext: {
      baseUrl,
      apiKey: env.ERPNEXT_API_KEY,
      apiSecret: env.ERPNEXT_API_SECRET,
      priceList: env.ERPNEXT_PRICE_LIST,
      priceSync: env.ERPNEXT_PRICE_SYNC,
      catalogSource: env.ERPNEXT_CATALOG_SOURCE,
      itemGroups: csv(env.ERPNEXT_ITEM_GROUPS),
      timeoutMs: env.ERPNEXT_TIMEOUT_MS,
      timezone: env.ERPNEXT_TIMEZONE,
      leadSource: env.ERPNEXT_LEAD_SOURCE?.trim() || undefined,
      leadAddComment: env.ERPNEXT_LEAD_ADD_COMMENT,
      leadSync: env.ERPNEXT_LEAD_SYNC,
      userSync: env.ERPNEXT_USER_SYNC,
      writes,
    },
    catalog: {
      ttlMs: env.CATALOG_CACHE_TTL_SECONDS * 1000,
      maxStaleMs: env.CATALOG_MAX_STALE_SECONDS * 1000,
    },
    inquirySyncIntervalMs: env.INQUIRY_SYNC_INTERVAL_SECONDS * 1000,
    publicUrl,
    mail: { from: env.MAIL_FROM ?? 'Agrismart <no-reply@agrismart.local>', smtp },
    session: {
      secureCookie: isProduction,
      // The __Host- prefix makes browsers require Secure, Path=/ and no Domain attribute.
      staff: {
        cookieName: isProduction ? '__Host-agrismart_session' : 'agrismart_session',
        ttlMs: env.SESSION_TTL_HOURS * 3600 * 1000,
        idleMs: env.STAFF_SESSION_IDLE_MINUTES * 60 * 1000,
      },
      customer: {
        cookieName: isProduction ? '__Host-agrismart_customer' : 'agrismart_customer',
        ttlMs: env.CUSTOMER_SESSION_TTL_HOURS * 3600 * 1000,
        idleMs: env.CUSTOMER_SESSION_IDLE_HOURS * 3600 * 1000,
      },
    },
    rateLimits: {
      global: { windowMs: 15 * 60 * 1000, limit: 600 },
      inquiries: { windowMs: 60 * 60 * 1000, limit: 5 },
      orders: { windowMs: 60 * 60 * 1000, limit: 10 },
      cartQuote: { windowMs: 60 * 1000, limit: 60 },
      login: { windowMs: 15 * 60 * 1000, limit: 10 },
      customerLogin: { windowMs: 15 * 60 * 1000, limit: 10 },
      register: { windowMs: 60 * 60 * 1000, limit: 5 },
      passwordReset: { windowMs: 60 * 60 * 1000, limit: 5 },
      tokenUse: { windowMs: 60 * 60 * 1000, limit: 20 },
      accountWrite: { windowMs: 15 * 60 * 1000, limit: 20 },
    },
  };
}
