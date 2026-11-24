import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/env.js';
import { TEST_API_SECRET, testEnv } from './helpers.js';

// Lead sync off: in test mode the write guard only allows writes to a local stub.
const base = testEnv('https://erp.example.com/', { ERPNEXT_ALLOWED_HOSTS: 'erp.example.com', ERPNEXT_LEAD_SYNC: 'false' });

const problemsOf = (env: NodeJS.ProcessEnv): string[] => {
  try {
    loadConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).problems;
  }
  throw new Error('expected ConfigError');
};

describe('configuration validation', () => {
  it('accepts a valid configuration and defaults the price list to MRP', () => {
    const config = loadConfig(base);
    expect(config.erpnext.priceList).toBe('MRP');
    expect(config.erpnext.baseUrl.host).toBe('erp.example.com');
  });

  it.each(['MONGODB_URI', 'ERPNEXT_BASE_URL', 'ERPNEXT_API_KEY', 'ERPNEXT_API_SECRET', 'ERPNEXT_ALLOWED_HOSTS'])(
    'fails when %s is missing',
    (name) => {
      const env = { ...base };
      delete env[name];
      expect(problemsOf(env).join(' ')).toContain(name);
    },
  );

  it('rejects placeholder secrets', () => {
    expect(problemsOf({ ...base, ERPNEXT_API_KEY: 'replace-me' }).join(' ')).toContain('placeholder');
  });

  it('rejects an ERPNext host that is not allowlisted (SSRF guard)', () => {
    expect(problemsOf({ ...base, ERPNEXT_BASE_URL: 'https://169.254.169.254/' }).join(' ')).toContain('not in ERPNEXT_ALLOWED_HOSTS');
  });

  it('rejects credentials, paths and queries in the ERPNext URL', () => {
    expect(problemsOf({ ...base, ERPNEXT_BASE_URL: 'https://u:p@erp.example.com/' }).join(' ')).toContain('credentials');
    expect(problemsOf({ ...base, ERPNEXT_BASE_URL: 'https://erp.example.com/app?x=1' }).join(' ')).toMatch(/query|site root/);
  });

  it('requires https and explicit CORS origins in production', () => {
    const problems = problemsOf({
      ...base,
      NODE_ENV: 'production',
      ERPNEXT_BASE_URL: 'http://erp.example.com/',
      CORS_ALLOWED_ORIGINS: '',
    });
    expect(problems.join(' ')).toContain('https in production');
    expect(problems.join(' ')).toContain('CORS_ALLOWED_ORIGINS is required');
  });

  it('rejects wildcard / non-origin CORS values', () => {
    expect(problemsOf({ ...base, CORS_ALLOWED_ORIGINS: '*' }).join(' ')).toContain('CORS_ALLOWED_ORIGINS');
    expect(problemsOf({ ...base, CORS_ALLOWED_ORIGINS: 'https://shop.example.com/path' }).join(' ')).toContain('bare origins');
  });

  const production = {
    ...base,
    NODE_ENV: 'production',
    ORIGIN_SHARED_SECRET: 'test-origin-secret-0123456789abcdefghij',
    ERPNEXT_PRICE_LIST: 'MRP',
    CORS_ALLOWED_ORIGINS: 'https://shop.example.com',
    APP_PUBLIC_URL: 'https://shop.example.com',
    SMTP_HOST: 'smtp.example.com',
    SMTP_USER: 'mailer',
    SMTP_PASS: 'smtp-password-123',
    MAIL_FROM: 'Agrismart <no-reply@shop.example.com>',
    ERPNEXT_LEAD_SYNC: 'true',
    ERPNEXT_WRITE_APPROVED_HOST: 'erp.example.com',
  };

  it('uses __Host- secure cookies for staff and customers in production', () => {
    const config = loadConfig(production);
    expect(config.session.staff.cookieName).toBe('__Host-agrismart_session');
    expect(config.session.customer.cookieName).toBe('__Host-agrismart_customer');
    expect(config.session.secureCookie).toBe(true);
  });

  it('requires email delivery and an https public URL in production (customer accounts)', () => {
    const noMail: Record<string, string | undefined> = { ...production, SMTP_HOST: undefined, MAIL_FROM: undefined };
    const problems = problemsOf({ ...noMail, APP_PUBLIC_URL: 'http://shop.example.com' }).join(' ');
    expect(problems).toContain('SMTP_HOST is required in production');
    expect(problems).toContain('MAIL_FROM is required in production');
    expect(problems).toContain('APP_PUBLIC_URL must use https');
    expect(problems).not.toContain('smtp-password-123');
  });

  it('never includes secret values in error messages', () => {
    const problems = problemsOf({ ...base, MONGODB_URI: 'not-a-uri', ERPNEXT_API_SECRET: TEST_API_SECRET, PORT: 'abc' });
    expect(problems.join(' ')).not.toContain(TEST_API_SECRET);
    expect(problems.join(' ')).not.toContain('not-a-uri');
  });
});
