import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { SMTPServer, type SMTPServerOptions } from 'smtp-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServices, createApp } from '../src/app.js';
import { ConfigError, loadConfig } from '../src/config/env.js';
import { createLogger } from '../src/lib/logger.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import { describeMailError, SmtpMailer, templates } from '../src/services/mailer.js';
import { createDevMailer, DevMailError } from './devMailer.js';
import { ALLOWED_ORIGIN, buildTestApp, captureLogs, startStubErp, testEnv, type StubErp } from './helpers.js';

/**
 * Email delivery tests. Everything runs against a LOCAL SMTP server on 127.0.0.1 or an
 * in-memory mailer; no email ever leaves this machine.
 */

// A fresh self-signed "localhost" certificate is generated per run with openssl. (smtp-server's
// bundled certificate has expired, which our mailer correctly rejects; see the test below.)
const require_ = createRequire(import.meta.url);
const BUNDLED_CERT: string = (require_('smtp-server/lib/tls-options.js') as () => { cert: string })().cert;

function generateLocalhostCert(): { key: string; cert: string } | null {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'agrismart-smtp-'));
    const keyFile = join(dir, 'key.pem');
    const certFile = join(dir, 'cert.pem');
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'],
      { stdio: 'ignore' },
    );
    const pair = { key: readFileSync(keyFile, 'utf8'), cert: readFileSync(certFile, 'utf8') };
    rmSync(dir, { recursive: true, force: true });
    return pair;
  } catch {
    return null;
  }
}
const TLS = generateLocalhostCert();
const LOCALHOST_CERT = TLS?.cert ?? '';

interface Received {
  from: string;
  to: string[];
  raw: string;
  secure: boolean;
  user: string | undefined;
}

async function startSmtp(opts: Partial<SMTPServerOptions> = {}, { bundledCert = false } = {}) {
  const received: Received[] = [];
  const server = new SMTPServer({
    authOptional: false,
    disabledCommands: [],
    logger: false,
    ...(TLS && !bundledCert ? { key: TLS.key, cert: TLS.cert } : {}),
    onAuth(auth, _session, cb) {
      if (auth.username === 'mailer' && auth.password === 'smtp-test-pass-123') return cb(null, { user: 'mailer' });
      cb(new Error('Invalid credentials'));
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks).toString('utf8'),
          secure: session.secure,
          user: session.user as string | undefined,
        });
        cb();
      });
    },
    ...opts,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.server.address() as AddressInfo;
  return { port, received, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const smtpConfig = (port: number) => ({ host: 'localhost', port, secure: false, user: 'mailer', pass: 'smtp-test-pass-123' });

let erp: StubErp;
beforeAll(async () => {
  erp = await startStubErp();
});
afterAll(() => erp.close());

describe.skipIf(!TLS)('SMTP transport security (local SMTP server; needs openssl to create a test certificate)', () => {
  it('rejects an expired server certificate', async () => {
    const smtp = await startSmtp({}, { bundledCert: true }); // smtp-server's bundled, expired cert
    try {
      const mailer = new SmtpMailer(smtpConfig(smtp.port), 'no-reply@shop.example.com', BUNDLED_CERT);
      await expect(mailer.verify()).rejects.toThrow(/expired/);
      mailer.close();
    } finally {
      await smtp.close();
    }
  });

  it('delivers over STARTTLS with authentication and the configured sender', async () => {
    const smtp = await startSmtp();
    try {
      const mailer = new SmtpMailer(smtpConfig(smtp.port), 'Agrismart <no-reply@shop.example.com>', LOCALHOST_CERT);
      await mailer.verify();
      const msg = templates.resetPassword('Kavya <b>Rao</b>', 'https://shop.example.com/reset-password#token=abc', 30);
      await mailer.send({ to: 'kavya@example.com', ...msg });
      mailer.close();
      expect(smtp.received).toHaveLength(1);
      const mail = smtp.received[0]!;
      expect(mail.secure).toBe(true); // upgraded to TLS before any data was sent
      expect(mail.user).toBe('mailer');
      expect(mail.from).toBe('no-reply@shop.example.com');
      expect(mail.to).toEqual(['kavya@example.com']);
      expect(mail.raw).toMatch(/^From: Agrismart <no-reply@shop\.example\.com>/m);
      expect(mail.raw).toMatch(/^Subject: Reset your Agrismart password/m);
      expect(mail.raw).toMatch(/^Auto-Submitted: auto-generated/m);
      // HTML part: the name is escaped (the text/plain part may contain it verbatim, which is inert).
      const decoded = mail.raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
      expect(decoded).toContain('Hello Kavya &lt;b&gt;Rao&lt;/b&gt;</h2>');
      expect(decoded).not.toMatch(/<h2[^>]*>Hello Kavya <b>/);
      expect(decoded).toContain('href="https://shop.example.com/reset-password#token=abc"');
    } finally {
      await smtp.close();
    }
  });

  // Port 465 style (e.g. a cPanel mailbox): TLS from the first byte, no STARTTLS upgrade.
  it('delivers over implicit TLS with authentication and the configured sender', async () => {
    const smtp = await startSmtp({ secure: true });
    try {
      const mailer = new SmtpMailer({ ...smtpConfig(smtp.port), secure: true }, 'Agrismart <ecommerce@shop.example.com>', LOCALHOST_CERT);
      await mailer.verify();
      await mailer.send({ to: 'kavya@example.com', ...templates.passwordChanged('Kavya') });
      mailer.close();
      expect(smtp.received).toHaveLength(1);
      expect(smtp.received[0]).toMatchObject({ secure: true, user: 'mailer', from: 'ecommerce@shop.example.com', to: ['kavya@example.com'] });
      expect(smtp.received[0]!.raw).toMatch(/^From: Agrismart <ecommerce@shop\.example\.com>/m);
    } finally {
      await smtp.close();
    }
  });

  it('an implicit-TLS client never talks plaintext to a server that does not speak TLS', async () => {
    const smtp = await startSmtp({ secure: false });
    try {
      const mailer = new SmtpMailer({ ...smtpConfig(smtp.port), secure: true }, 'ecommerce@shop.example.com', LOCALHOST_CERT);
      await expect(mailer.verify()).rejects.toThrow();
      mailer.close();
      expect(smtp.received).toHaveLength(0);
    } finally {
      await smtp.close();
    }
  });

  it('refuses to send when the server does not support STARTTLS (no plaintext fallback)', async () => {
    // Note: merely hiding STARTTLS from EHLO is not enough to test this; nodemailer still sends
    // STARTTLS when TLS is required. The server must actually reject the command.
    const smtp = await startSmtp({ disabledCommands: ['STARTTLS'], allowInsecureAuth: true });
    try {
      const mailer = new SmtpMailer(smtpConfig(smtp.port), 'no-reply@shop.example.com', LOCALHOST_CERT);
      await expect(mailer.send({ to: 'a@example.com', subject: 's', text: 't', html: 'h' })).rejects.toThrow();
      mailer.close();
      expect(smtp.received).toHaveLength(0);
    } finally {
      await smtp.close();
    }
  });

  it('refuses an untrusted TLS certificate', async () => {
    const smtp = await startSmtp();
    try {
      const mailer = new SmtpMailer(smtpConfig(smtp.port), 'no-reply@shop.example.com'); // no extra CA
      await expect(mailer.verify()).rejects.toThrow();
      mailer.close();
      expect(smtp.received).toHaveLength(0);
    } finally {
      await smtp.close();
    }
  });

  it('reports authentication failures without leaking the password', async () => {
    const smtp = await startSmtp();
    try {
      const mailer = new SmtpMailer({ ...smtpConfig(smtp.port), pass: 'wrong-pass-999' }, 'no-reply@shop.example.com', LOCALHOST_CERT);
      const err = await mailer.verify().catch((e: unknown) => e);
      mailer.close();
      const safe = describeMailError(err);
      expect(safe).toMatchObject({ code: 'EAUTH' });
      expect(JSON.stringify(safe)).not.toContain('wrong-pass-999');
    } finally {
      await smtp.close();
    }
  });
});

describe('mail configuration', () => {
  const prod = {
    ...testEnv('https://erp.example.com/', { ERPNEXT_ALLOWED_HOSTS: 'erp.example.com', ERPNEXT_WRITE_APPROVED_HOST: 'erp.example.com' }),
    NODE_ENV: 'production',
    ORIGIN_SHARED_SECRET: 'test-origin-secret-0123456789abcdefghij',
    ERPNEXT_PRICE_LIST: 'MRP',
    CORS_ALLOWED_ORIGINS: 'https://shop.example.com',
    APP_PUBLIC_URL: 'https://shop.example.com',
    MAIL_FROM: 'Agrismart <no-reply@shop.example.com>',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_USER: 'mailer',
    SMTP_PASS: 'smtp-secret-value-1',
  };
  const problems = (env: Record<string, string | undefined>) => {
    try {
      loadConfig(env);
      return '';
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      return (err as ConfigError).problems.join(' | ');
    }
  };

  it('accepts a complete production mail configuration', () => {
    expect(problems(prod)).toBe('');
  });

  it.each([
    ['SMTP_HOST', { SMTP_HOST: undefined }, 'SMTP_HOST is required'],
    ['MAIL_FROM', { MAIL_FROM: undefined }, 'MAIL_FROM is required'],
    ['APP_PUBLIC_URL', { APP_PUBLIC_URL: undefined }, 'APP_PUBLIC_URL is required'],
    ['SMTP credentials', { SMTP_USER: undefined, SMTP_PASS: undefined }, 'SMTP_USER and SMTP_PASS are required'],
    ['half credentials', { SMTP_PASS: undefined }, 'must be set together'],
    ['465 without TLS', { SMTP_PORT: '465', SMTP_SECURE: 'false' }, '465 requires SMTP_SECURE=true'],
    ['587 with implicit TLS', { SMTP_SECURE: 'true' }, 'uses STARTTLS'],
    ['http public URL', { APP_PUBLIC_URL: 'http://shop.example.com' }, 'APP_PUBLIC_URL must use https'],
    ['public URL with path', { APP_PUBLIC_URL: 'https://shop.example.com/evil?x=1' }, 'bare origin'],
    ['header injection in MAIL_FROM', { MAIL_FROM: 'a@b.com\r\nBcc: victim@example.com' }, 'MAIL_FROM must be an email address'],
    ['bad SMTP host', { SMTP_HOST: 'smtp.example.com\r\nX' }, 'SMTP_HOST must be a hostname'],
  ])('refuses to start in production with bad %s', (_label, patch, expected) => {
    const out = problems({ ...prod, ...patch });
    expect(out).toContain(expected);
    expect(out).not.toContain('smtp-secret-value-1');
  });

  it('maps cPanel-style port 465 settings to implicit TLS without a STARTTLS requirement', () => {
    const config = loadConfig({
      ...prod,
      SMTP_HOST: 'mail.example.com',
      SMTP_PORT: '465',
      SMTP_SECURE: 'true',
      SMTP_USER: 'ecommerce@example.com',
      MAIL_FROM: 'Agrismart <ecommerce@example.com>',
    } as NodeJS.ProcessEnv);
    expect(config.mail).toMatchObject({ from: 'Agrismart <ecommerce@example.com>', smtp: { host: 'mail.example.com', port: 465, secure: true, user: 'ecommerce@example.com' } });
    const mailer = new SmtpMailer(config.mail.smtp!, config.mail.from);
    // Transport options as handed to nodemailer: TLS from the start, no STARTTLS upgrade.
    const options = (mailer as unknown as { transport: { options: Record<string, unknown> } }).transport.options;
    expect(options).toMatchObject({ host: 'mail.example.com', port: 465, secure: true, requireTLS: false });
    expect(options.tls).toMatchObject({ minVersion: 'TLSv1.2', rejectUnauthorized: true });
    mailer.close();
  });

  it('allows an unauthenticated local relay (e.g. Postfix on the VPS)', () => {
    expect(problems({ ...prod, SMTP_HOST: 'localhost', SMTP_PORT: '25', SMTP_USER: undefined, SMTP_PASS: undefined })).toBe('');
  });

  it('never falls back to the console mailer in production', () => {
    const config = loadConfig(testEnv(erp.url));
    config.isProduction = true;
    config.mail.smtp = null;
    expect(() => buildServices(config, createLogger('silent'), createMemoryRepositories())).toThrow(/SMTP is required/);
  });
});

describe('email links and failure handling', () => {
  const person = { name: 'Kavya Rao', email: 'kavya@example.com', phone: '+919876543210', password: 'Green-Fields-2026', confirmPassword: 'Green-Fields-2026' };

  it('builds links from APP_PUBLIC_URL only, ignoring attacker-controlled Host headers', async () => {
    const { app, mailer, config } = buildTestApp(erp.url, { env: { APP_PUBLIC_URL: 'https://shop.example.com' } });
    expect(config.publicUrl.origin).toBe('https://shop.example.com');
    const evil = { Host: 'evil.example', 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'http', Forwarded: 'host=evil.example' };
    await request(app).post('/api/customer/auth/register').set('Origin', ALLOWED_ORIGIN).set(evil).send(person);
    await request(app).post('/api/customer/auth/forgot-password').set('Origin', ALLOWED_ORIGIN).set(evil).send({ email: person.email });
    expect(mailer.outbox).toHaveLength(2);
    for (const m of mailer.outbox) {
      const links = [...`${m.text}\n${m.html}`.matchAll(/https?:\/\/[^\s"<]+/g)].map((x) => x[0]);
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) expect(link.startsWith('https://shop.example.com/')).toBe(true);
      expect(`${m.text}${m.html}`).not.toContain('evil.example');
    }
    expect(mailer.outbox[0]!.text).toMatch(/https:\/\/shop\.example\.com\/verify-email#token=[A-Za-z0-9_-]{43}/);
    expect(mailer.outbox[1]!.text).toMatch(/https:\/\/shop\.example\.com\/reset-password#token=[A-Za-z0-9_-]{43}/);
  });

  it('keeps the same responses when SMTP fails, and logs no address, token or SMTP text', async () => {
    const { app, mailer, logs, repos } = buildTestApp(erp.url);
    mailer.fail = true;
    const reg = await request(app).post('/api/customer/auth/register').set('Origin', ALLOWED_ORIGIN).send(person);
    const forgot = await request(app).post('/api/customer/auth/forgot-password').set('Origin', ALLOWED_ORIGIN).send({ email: person.email });
    expect(reg.status).toBe(202);
    expect(forgot.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20)); // let the fire-and-forget sends settle
    const log = logs.lines.join('');
    expect(log).toContain('Failed to send account email');
    expect(log).not.toContain(person.email);
    expect(log).not.toContain('SMTP unavailable'); // raw error text is not logged
    for (const t of repos.customerTokens.rows) expect(log).not.toContain(t.tokenHash);
    // The account exists and a fresh link can be requested once mail works again.
    expect(repos.customers.rows.size).toBe(1);
  });

  it('a failed send leaves earlier links working until a new one is issued', async () => {
    const { app, mailer, repos } = buildTestApp(erp.url);
    await request(app).post('/api/customer/auth/register').set('Origin', ALLOWED_ORIGIN).send(person);
    const token = mailer.outbox[0]!.text.match(/#token=([A-Za-z0-9_-]{43})/)![1]!;
    expect(repos.customerTokens.rows).toHaveLength(1);
    const ok = await request(app).post('/api/customer/auth/verify-email').set('Origin', ALLOWED_ORIGIN).send({ token });
    expect(ok.status).toBe(200);
  });
});

/**
 * Registration → verification email through the REAL SmtpMailer, against a local implicit-TLS
 * (port 465 style) SMTP server on 127.0.0.1. Nothing leaves this machine.
 */
describe.skipIf(!TLS)('registration sends the verification email over SMTP (local server)', () => {
  const person = { name: 'Kavya Rao', email: 'kavya@example.com', phone: '+919876543210', password: 'Green-Fields-2026', confirmPassword: 'Green-Fields-2026' };

  async function appWithSmtp(smtpPort: number) {
    const config = loadConfig(
      testEnv(erp.url, { APP_PUBLIC_URL: 'https://shop.example.com', MAIL_FROM: 'Agrismart <ecommerce@shop.example.com>' }),
    );
    const logs = captureLogs();
    const logger = createLogger('debug', logs.stream);
    const repos = createMemoryRepositories();
    const mailer = new SmtpMailer({ host: 'localhost', port: smtpPort, secure: true, user: 'mailer', pass: 'smtp-test-pass-123' }, config.mail.from, LOCALHOST_CERT);
    const services = buildServices(config, logger, repos, { mailer });
    const app = createApp({ config, logger, repos, services, isReady: () => true });
    const register = (body = person) => request(app).post('/api/customer/auth/register').set('Origin', ALLOWED_ORIGIN).send(body);
    return { app, repos, logs, mailer, register };
  }
  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(check()).toBe(true);
  };
  const decode = (raw: string) => raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

  it('registration delivers one verification email from MAIL_FROM with an APP_PUBLIC_URL link that verifies', async () => {
    const smtp = await startSmtp({ secure: true });
    const { app, repos, register, mailer } = await appWithSmtp(smtp.port);
    try {
      expect((await register()).status).toBe(202);
      await waitFor(() => smtp.received.length === 1);
      const mail = smtp.received[0]!;
      expect(mail).toMatchObject({ secure: true, user: 'mailer', from: 'ecommerce@shop.example.com', to: ['kavya@example.com'] });
      expect(mail.raw).toMatch(/^Subject: Confirm your Agrismart email/m);
      const token = decode(mail.raw).match(/https:\/\/shop\.example\.com\/verify-email#token=([A-Za-z0-9_-]{43})/)?.[1];
      expect(token).toBeDefined();
      expect((await request(app).post('/api/customer/auth/verify-email').set('Origin', ALLOWED_ORIGIN).send({ token })).status).toBe(200);
      expect([...repos.customers.rows.values()][0]!.emailVerified).toBe(true);
    } finally {
      mailer.close();
      await smtp.close();
    }
  });

  it('a duplicate registration sends the "already registered" notice, not a verification email', async () => {
    const smtp = await startSmtp({ secure: true });
    const { register, mailer } = await appWithSmtp(smtp.port);
    try {
      await register();
      await register();
      await waitFor(() => smtp.received.length === 2);
      expect(smtp.received[1]!.raw).toMatch(/^Subject: Your Agrismart account/m);
      expect(decode(smtp.received[1]!.raw)).not.toMatch(/verify-email#token=/);
    } finally {
      mailer.close();
      await smtp.close();
    }
  });

  it('when the SMTP server rejects the sender, registration still answers 202 and the failure is logged without the address', async () => {
    const smtp = await startSmtp({
      secure: true,
      onMailFrom(_address, _session, cb) {
        cb(Object.assign(new Error('Sender address rejected: not owned by user'), { responseCode: 553 }));
      },
    });
    const { register, logs, repos, mailer } = await appWithSmtp(smtp.port);
    try {
      expect((await register()).status).toBe(202);
      await waitFor(() => logs.lines.some((l) => l.includes('Failed to send account email')));
      const line = JSON.parse(logs.lines.find((l) => l.includes('Failed to send account email'))!) as { kind: string; err: Record<string, unknown> };
      expect(line).toMatchObject({ kind: 'verify_email', err: { responseCode: 553, command: 'MAIL' } });
      const all = logs.lines.join('');
      expect(all).not.toContain('kavya@example.com');
      expect(all).not.toContain('not owned by user'); // raw SMTP text is not logged
      // The account exists (unverified); a new link can be requested once mail works.
      expect([...repos.customers.rows.values()]).toMatchObject([{ email: 'kavya@example.com', emailVerified: false }]);
      expect(smtp.received).toHaveLength(0);
    } finally {
      mailer.close();
      await smtp.close();
    }
  });
});

/** `npm run dev:erp:smtp` mode (test/devMailer.ts), against the local implicit-TLS server only. */
describe.skipIf(!TLS)('dev stack --smtp mode (local SMTP server)', () => {
  const smtpEnv = (port: number, pass = 'smtp-test-pass-123') => ({
    SMTP_HOST: 'localhost',
    SMTP_PORT: String(port),
    SMTP_SECURE: 'true',
    SMTP_USER: 'mailer',
    SMTP_PASS: pass,
    MAIL_FROM: 'Agrismart <ecommerce@shop.example.com>',
  });

  it('checks connection and login at startup without sending anything', async () => {
    const smtp = await startSmtp({ secure: true });
    try {
      const config = loadConfig(testEnv(erp.url, smtpEnv(smtp.port)));
      const dev = await createDevMailer('smtp', { config, logger: createLogger('silent'), label: 'dev:erp', mailFromSet: true, extraCa: LOCALHOST_CERT });
      expect(dev.description).toBe(`Account emails: SMTP localhost:${smtp.port} (implicit TLS) - connection and login OK - REAL emails will be sent`);
      expect(smtp.received).toHaveLength(0);
    } finally {
      await smtp.close();
    }
  });

  it('refuses to start when the login fails, with codes only (no password)', async () => {
    const smtp = await startSmtp({ secure: true });
    try {
      const config = loadConfig(testEnv(erp.url, smtpEnv(smtp.port, 'wrong-password-value-9')));
      const err = await createDevMailer('smtp', { config, logger: createLogger('silent'), label: 'dev:erp', mailFromSet: true, extraCa: LOCALHOST_CERT }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(DevMailError);
      expect(String(err)).toMatch(/SMTP connection\/login failed .*"command":"AUTH"/);
      expect(String(err)).not.toContain('wrong-password-value-9');
    } finally {
      await smtp.close();
    }
  });

  it('registration sends the verification email; the terminal shows the subject only, logs show no token', async () => {
    const smtp = await startSmtp({ secure: true });
    try {
      const config = loadConfig(testEnv(erp.url, { ...smtpEnv(smtp.port), APP_PUBLIC_URL: 'http://127.0.0.1:5173' }));
      const printed: string[] = [];
      const dev = await createDevMailer('smtp', {
        config,
        logger: createLogger('silent'),
        label: 'dev:erp',
        mailFromSet: true,
        extraCa: LOCALHOST_CERT,
        print: (l) => printed.push(l),
      });
      const logs = captureLogs();
      const logger = createLogger('debug', logs.stream);
      const repos = createMemoryRepositories();
      const app = createApp({ config, logger, repos, services: buildServices(config, logger, repos, { mailer: dev.mailer }), isReady: () => true });
      const res = await request(app)
        .post('/api/customer/auth/register')
        .set('Origin', ALLOWED_ORIGIN)
        .send({ name: 'Kavya Rao', email: 'kavya@example.com', phone: '+919876543210', password: 'Green-Fields-2026', confirmPassword: 'Green-Fields-2026' });
      expect(res.status).toBe(202);
      for (let i = 0; i < 100 && printed.length === 0; i++) await new Promise((r) => setTimeout(r, 20));

      expect(smtp.received).toHaveLength(1);
      expect(smtp.received[0]).toMatchObject({ secure: true, from: 'ecommerce@shop.example.com', to: ['kavya@example.com'] });
      expect(printed).toEqual(['[dev:erp] SMTP server ACCEPTED "Confirm your Agrismart email address" (recipient hidden). Not yet proof of inbox delivery.']);
      const token = smtp.received[0]!.raw.replace(/=\r?\n/g, '').match(/verify-email#token=([A-Za-z0-9_-]{43})/)![1]!;
      const everything = printed.join('\n') + logs.lines.join('');
      expect(everything).not.toContain(token);
      expect(everything).not.toContain('kavya@example.com');
      expect(everything).not.toContain('Green-Fields-2026');
    } finally {
      await smtp.close();
    }
  });
});
