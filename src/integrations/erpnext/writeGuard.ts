/**
 * Fail-closed guard for every ERPNext write (Lead, Comment, E-commerce User).
 *
 * Developer machines may hold production ERPNext credentials (e.g. for the read-only
 * `npm run dev:erp`). This guard makes sure that local development and automated tests can never
 * write to production, whatever sync flags are set:
 *
 *  - test runtime (NODE_ENV=test or a Vitest worker): writes only to a loopback stub, never
 *    anywhere else, and ERPNEXT_WRITE_APPROVED_HOST is ignored;
 *  - a production ERPNext host: writes only with NODE_ENV=production AND
 *    ERPNEXT_WRITE_APPROVED_HOST equal to that exact host;
 *  - any other host (staging): writes only when ERPNEXT_WRITE_APPROVED_HOST equals that exact host;
 *  - a loopback host in development (dev:mock stub): allowed.
 *
 * Hosts are compared exactly (WHATWG URL hostname, lower case), never by substring or suffix.
 * The check runs twice: when the configuration is loaded (so a misconfigured server refuses to
 * start) and again in the ERPNext client right before each write request.
 */

/** Production ERPNext sites. Exact hostnames only. */
export const PRODUCTION_ERPNEXT_HOSTS: ReadonlySet<string> = new Set(['asfsl.sanvidhierp.in']);

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export type RuntimeEnv = 'development' | 'test' | 'production';

export interface WritePolicy {
  allowed: boolean;
  /** Human-readable, contains no hostnames or credentials. */
  reason: string;
}

export const WRITES_DENIED: WritePolicy = { allowed: false, reason: 'ERPNext writes are not enabled for this client' };

export const isLoopbackHost = (host: string) => LOOPBACK_HOSTS.has(host.toLowerCase());
export const isProductionHost = (host: string) => PRODUCTION_ERPNEXT_HOSTS.has(host.toLowerCase());

/** True inside automated tests, whatever NODE_ENV says (Vitest always sets VITEST). */
export const isTestRuntime = (env: NodeJS.ProcessEnv = process.env) => env.NODE_ENV === 'test' || env.VITEST !== undefined;

/** Decides whether this runtime may write to the ERPNext site at `baseUrl`. */
export function erpnextWritePolicy(input: { env: RuntimeEnv; baseUrl: URL; approvedHost: string | undefined; testRuntime?: boolean }): WritePolicy {
  const host = input.baseUrl.hostname.toLowerCase();
  const approved = input.approvedHost?.trim().toLowerCase() || undefined;
  if (input.env === 'test' || input.testRuntime) {
    return isLoopbackHost(host)
      ? { allowed: true, reason: 'test runtime writing to a local stub' }
      : { allowed: false, reason: 'automated tests may only write to a local ERPNext stub' };
  }
  if (isProductionHost(host)) {
    if (input.env !== 'production') return { allowed: false, reason: 'production ERPNext can only be written by a production runtime (NODE_ENV=production)' };
    return approved === host
      ? { allowed: true, reason: 'production runtime with the approved production host' }
      : { allowed: false, reason: 'ERPNEXT_WRITE_APPROVED_HOST must name the production ERPNext host exactly' };
  }
  if (isLoopbackHost(host) && input.env === 'development') return { allowed: true, reason: 'development writing to a local stub' };
  return approved === host
    ? { allowed: true, reason: 'approved non-production ERPNext host' }
    : { allowed: false, reason: 'ERPNEXT_WRITE_APPROVED_HOST must name this ERPNext host exactly' };
}

/**
 * Last line of defence, evaluated in the client right before a write. Independent of the loaded
 * configuration, so a client built with an over-permissive policy still cannot write to
 * production from a test or a non-production process.
 */
export function runtimeWriteBlock(baseUrl: URL, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isProductionHost(baseUrl.hostname)) return null;
  if (isTestRuntime(env)) return 'automated tests can never write to production ERPNext';
  if (env.NODE_ENV !== 'production') return 'production ERPNext can only be written by a production runtime';
  return null;
}
