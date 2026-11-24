import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/env.js';
import { ErpNextClient, ErpNextError, parseRetryAfter } from '../src/integrations/erpnext/client.js';
import { erpnextWritePolicy, isProductionHost, runtimeWriteBlock } from '../src/integrations/erpnext/writeGuard.js';
import { ErpNextUserRegistry, syncCustomerToRegistry } from '../src/services/userRegistry.js';
import { createLogger } from '../src/lib/logger.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import { TEST_API_KEY, TEST_API_SECRET, testEnv } from './helpers.js';

/**
 * The production ERPNext site must be unreachable for writes from tests and local development,
 * whatever sync flags are set. No test here performs real network I/O: every client below uses a
 * recording fetch stub, so nothing can reach the production host even if a guard failed.
 */
const PROD = 'asfsl.sanvidhierp.in';
const prodUrl = new URL(`https://${PROD}/`);
const stagingUrl = new URL('https://staging-erp.example.test/');

function recordingFetch(handler: (url: URL, init: RequestInit) => Response = () => new Response('{"data":{}}', { status: 200 })) {
  const calls: { method: string; url: URL; init: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ method: String(init.method ?? 'GET'), url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const problemsOf = (env: NodeJS.ProcessEnv): string[] => {
  try {
    loadConfig(env);
    return [];
  } catch (err) {
    return err instanceof ConfigError ? err.problems : ['not a ConfigError'];
  }
};

describe('write policy', () => {
  const policy = (env: 'development' | 'test' | 'production', baseUrl: URL, approvedHost?: string) =>
    erpnextWritePolicy({ env, baseUrl, approvedHost }).allowed;

  it('test mode writes only to a local stub, never to production, whatever is approved', () => {
    expect(policy('test', new URL('http://127.0.0.1:4100/'))).toBe(true);
    expect(policy('test', prodUrl, PROD)).toBe(false);
    expect(policy('test', stagingUrl, 'staging-erp.example.test')).toBe(false);
    // Vitest marks the runtime as a test even if NODE_ENV says otherwise.
    expect(erpnextWritePolicy({ env: 'production', baseUrl: prodUrl, approvedHost: PROD, testRuntime: true }).allowed).toBe(false);
  });

  it('development can never write to production, even when the host is "approved"', () => {
    expect(policy('development', prodUrl)).toBe(false);
    expect(policy('development', prodUrl, PROD)).toBe(false);
    expect(policy('development', new URL('http://localhost:4100/'))).toBe(true); // dev:mock stub
  });

  it('staging needs its exact host approved; production needs a production runtime and the exact host', () => {
    expect(policy('development', stagingUrl)).toBe(false);
    expect(policy('development', stagingUrl, 'staging-erp.example.test')).toBe(true);
    expect(policy('development', stagingUrl, 'example.test')).toBe(false);
    expect(policy('production', prodUrl)).toBe(false);
    expect(policy('production', prodUrl, 'sanvidhierp.in')).toBe(false);
    expect(policy('production', prodUrl, PROD)).toBe(true);
    expect(policy('production', new URL('http://127.0.0.1:4100/'))).toBe(false); // loopback in production also needs approval
  });

  it('matches hosts exactly, never by substring or suffix', () => {
    expect(isProductionHost(PROD)).toBe(true);
    expect(isProductionHost('ASFSL.SANVIDHIERP.IN')).toBe(true);
    for (const look of [`${PROD}.evil.example`, `evil-${PROD}`, `x.${PROD}`, 'sanvidhierp.in']) {
      expect(isProductionHost(look)).toBe(false);
      // A look-alike is a non-production host: it still needs its own exact approval.
      expect(policy('development', new URL(`https://${look}/`), PROD)).toBe(false);
    }
  });
});

describe('configuration fails closed', () => {
  const prodEnv = (extra: Record<string, string>) =>
    testEnv(prodUrl.toString(), { ERPNEXT_ALLOWED_HOSTS: PROD, NODE_ENV: 'development', ...extra } as Record<string, string>);

  it('refuses to start local development against production with any sync enabled', () => {
    const cases: Record<string, string>[] = [{ ERPNEXT_LEAD_SYNC: 'true' }, { ERPNEXT_LEAD_SYNC: 'false', ERPNEXT_USER_SYNC: 'true' }, {}];
    for (const flags of cases) {
      const problems = problemsOf(prodEnv(flags));
      expect(problems.join(' ')).toMatch(/ERPNext writes are not allowed here/);
      // Sanitised: no key, secret or host value in the message.
      expect(problems.join(' ')).not.toMatch(new RegExp(`${TEST_API_KEY}|${TEST_API_SECRET}|${PROD.replace(/\./g, '\\.')}`));
    }
  });

  it('allows read-only local development against production (sync off), with writes disabled', () => {
    const config = loadConfig(prodEnv({ ERPNEXT_LEAD_SYNC: 'false', ERPNEXT_USER_SYNC: 'false' }));
    expect(config.erpnext.writes.allowed).toBe(false);
  });

  it('automated tests cannot be configured to write to production, even with sync and approval set', () => {
    const env = testEnv(prodUrl.toString(), { ERPNEXT_ALLOWED_HOSTS: PROD, ERPNEXT_USER_SYNC: 'true', ERPNEXT_LEAD_SYNC: 'true' });
    expect(problemsOf(env).join(' ')).toMatch(/only write to a local ERPNext stub/);
    expect(problemsOf({ ...env, NODE_ENV: 'development', ERPNEXT_WRITE_APPROVED_HOST: PROD }).join(' ')).toMatch(/only with NODE_ENV=production/);
  });

  it('rejects malformed or mismatched approved hosts', () => {
    const staging = (approved: string) =>
      problemsOf(testEnv(stagingUrl.toString(), { ERPNEXT_ALLOWED_HOSTS: 'staging-erp.example.test', NODE_ENV: 'development', ERPNEXT_WRITE_APPROVED_HOST: approved }));
    for (const bad of ['https://staging-erp.example.test', 'staging-erp.example.test:443', '*.example.test', 'staging-erp.example.test/', 'STAGING-ERP.example.test']) {
      expect(staging(bad).join(' ')).toMatch(/bare lower-case hostname/);
    }
    expect(staging('other.example.test').join(' ')).toMatch(/does not match/);
    expect(staging('staging-erp.example.test')).toEqual([]);
  });

  it('accepts an explicit production runtime with the exact approved host', () => {
    const env = {
      ...testEnv(prodUrl.toString(), { ERPNEXT_ALLOWED_HOSTS: PROD, ERPNEXT_WRITE_APPROVED_HOST: PROD }),
      NODE_ENV: 'production',
      ORIGIN_SHARED_SECRET: 'test-origin-secret-0123456789abcdefghij',
      CORS_ALLOWED_ORIGINS: 'https://shop.example.com',
      APP_PUBLIC_URL: 'https://shop.example.com',
      ERPNEXT_PRICE_LIST: 'MRP',
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'mailer',
      SMTP_PASS: 'smtp-password-123',
      MAIL_FROM: 'Agrismart <no-reply@shop.example.com>',
    };
    expect(loadConfig(env).erpnext.writes.allowed).toBe(true);
    // ...yet this process (a Vitest worker) still cannot write to it: see the client tests below.
  });
});

describe('ERPNext client write guard (no network: recording fetch stub)', () => {
  const client = (baseUrl: URL, fetchImpl: typeof fetch, allowed: boolean) =>
    new ErpNextClient({ baseUrl, apiKey: TEST_API_KEY, apiSecret: TEST_API_SECRET, timeoutMs: 500, fetchImpl, writes: { allowed, reason: 'test' } });

  it('never sends a write to production from a test, even with an "allowed" policy', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const c = client(prodUrl, fetchImpl, true);
    await expect(c.insert('E-commerce User', { website_user_id: 'x' })).rejects.toMatchObject({ kind: 'write_blocked' });
    await expect(c.update('E-commerce User', 'x', { customer_name: 'y' })).rejects.toMatchObject({ kind: 'write_blocked' });
    await expect(c.insert('Lead', { first_name: 'x' })).rejects.toBeInstanceOf(ErpNextError);
    expect(calls).toHaveLength(0);
  });

  it('a read-only client (no write policy) refuses writes anywhere', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const c = new ErpNextClient({ baseUrl: new URL('http://127.0.0.1:9/'), apiKey: TEST_API_KEY, apiSecret: TEST_API_SECRET, timeoutMs: 500, fetchImpl });
    await expect(c.insert('Lead', {})).rejects.toMatchObject({ kind: 'write_blocked' });
    expect(calls).toHaveLength(0);
  });

  it('runtime block is independent of configuration', () => {
    expect(runtimeWriteBlock(prodUrl, { NODE_ENV: 'development' })).toMatch(/production runtime/);
    expect(runtimeWriteBlock(prodUrl, { NODE_ENV: 'test' })).toMatch(/never write to production/);
    expect(runtimeWriteBlock(prodUrl, { NODE_ENV: 'production', VITEST: 'true' })).toMatch(/never write to production/);
    expect(runtimeWriteBlock(prodUrl, { NODE_ENV: 'production' })).toBeNull();
    expect(runtimeWriteBlock(stagingUrl, { NODE_ENV: 'development' })).toBeNull();
  });

  it('an approved staging configuration uses the real write path (to the staging host only), without redirects', async () => {
    const policy = erpnextWritePolicy({ env: 'development', baseUrl: stagingUrl, approvedHost: 'staging-erp.example.test' });
    expect(policy.allowed).toBe(true);
    const { calls, fetchImpl } = recordingFetch((url, init) =>
      init.method === 'POST' ? new Response(JSON.stringify({ data: { name: 'ECU-2026-00001' } }), { status: 200 }) : new Response('{"data":[]}', { status: 200 }),
    );
    const c = new ErpNextClient({ baseUrl: stagingUrl, apiKey: TEST_API_KEY, apiSecret: TEST_API_SECRET, timeoutMs: 500, fetchImpl, writes: policy });
    expect(await new ErpNextUserRegistry(c).upsert({
      customer_name: 'Staging Test',
      email: 'staging@example.test',
      mobile: '+919876543210',
      registration_date: '2026-10-27',
      email_verified: 1,
      account_status: 'Active',
      last_login: null,
      last_activity: null,
    }, null)).toEqual({ result: 'created', name: 'ECU-2026-00001' });
    expect(calls.map((x) => `${x.method} ${x.url.hostname}`)).toEqual(['GET staging-erp.example.test', 'POST staging-erp.example.test']);
    expect(calls.every((x) => x.init.redirect === 'error')).toBe(true);
    expect(calls.some((x) => isProductionHost(x.url.hostname))).toBe(false);
  });

  it('a sync pointed at production from a test pauses (write_blocked) and sends nothing but a stubbed read', async () => {
    const repos = createMemoryRepositories();
    const c = await repos.customers.create({ email: 'guard@example.com', name: 'G', phone: '+919876543210', passwordHash: 'h' });
    await repos.customers.markEmailVerified(c.id, new Date());
    const { calls, fetchImpl } = recordingFetch(() => new Response('{"data":[]}', { status: 200 })); // no record with that email yet
    const gateway = new ErpNextUserRegistry(client(prodUrl, fetchImpl, true));
    const outcome = await syncCustomerToRegistry(repos.customers, gateway, c.id, { timezone: 'Asia/Kolkata' }, createLogger('silent'));
    expect(outcome).toEqual({ status: 'paused', problem: 'write_blocked' });
    expect(calls.filter((x) => x.method !== 'GET')).toHaveLength(0);
    expect((await repos.customers.findById(c.id))!.registrySync).toMatchObject({ attempts: 0, failure: null, lockToken: null });
  });

  it('parses Retry-After safely', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
    expect(parseRetryAfter('99999999')).toBe(24 * 3600_000); // capped
    expect(parseRetryAfter('Tue, 27 Oct 2026 07:00:00 GMT', Date.parse('Tue, 27 Oct 2026 06:59:00 GMT'))).toBe(60_000);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
