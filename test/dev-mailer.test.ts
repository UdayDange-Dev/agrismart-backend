import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { createLogger } from '../src/lib/logger.js';
import { ConsoleMailer, MemoryMailer, SmtpMailer } from '../src/services/mailer.js';
import { createDevMailer, DevMailError, selectDevMailMode } from './devMailer.js';
import { ALLOWED_ORIGIN, buildTestApp, startStubErp, testEnv, type StubErp } from './helpers.js';

/** Which mailer each local command uses, and the registration → email flow with a mocked mailer. */
let erp: StubErp;
beforeAll(async () => {
  erp = await startStubErp();
});
afterAll(() => erp.close());

const DEV = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;
const SMTP_ENV = { SMTP_HOST: 'mail.example.com', SMTP_PORT: '465', SMTP_SECURE: 'true', SMTP_USER: 'shop@example.com', SMTP_PASS: 'not-a-real-password-1' };

describe('dev stack mail mode', () => {
  it('defaults to the console; the file outbox for browser tests; real SMTP only with --smtp', () => {
    expect(selectDevMailMode(['node', 'devStack.ts', '--real-erp'], DEV)).toBe('console'); // npm run dev:erp
    expect(selectDevMailMode(['node', 'devStack.ts'], DEV)).toBe('console'); // npm run dev:mock
    expect(selectDevMailMode(['node', 'devStack.ts'], { ...DEV, DEV_MAIL_OUTBOX: '/tmp/x.jsonl' })).toBe('outbox'); // Playwright
    expect(selectDevMailMode(['node', 'devStack.ts', '--real-erp', '--smtp'], DEV)).toBe('smtp'); // npm run dev:erp:smtp
    // SMTP settings alone (e.g. in Backend/.env) never switch it on.
    expect(selectDevMailMode(['node', 'devStack.ts', '--real-erp'], { ...DEV, ...SMTP_ENV })).toBe('console');
  });

  it('refuses real SMTP under a test runner or together with the browser-test outbox', () => {
    expect(() => selectDevMailMode(['--smtp'], { NODE_ENV: 'test' })).toThrow(DevMailError);
    expect(() => selectDevMailMode(['--smtp'], { ...DEV, VITEST: 'true' })).toThrow(/test runner/);
    // This process is a Vitest worker: real SMTP is impossible here whatever the arguments.
    expect(() => selectDevMailMode(['--smtp'], process.env)).toThrow(/test runner/);
    expect(() => selectDevMailMode(['--smtp'], { ...DEV, DEV_MAIL_OUTBOX: '/tmp/x.jsonl' })).toThrow(/cannot be combined/);
  });

  it('validates SMTP settings before starting in SMTP mode, without printing secrets', async () => {
    const logger = createLogger('silent');
    const make = (env: Record<string, string>, mailFromSet = true) =>
      createDevMailer('smtp', { config: loadConfig(testEnv(erp.url, env)), logger, label: 'dev:erp', mailFromSet });
    await expect(make({})).rejects.toThrow(/needs SMTP_HOST/);
    await expect(make({ ...SMTP_ENV }, false)).rejects.toThrow(/needs MAIL_FROM/);
    const noAuth = loadConfig(testEnv(erp.url, { SMTP_HOST: 'localhost', SMTP_PORT: '25' }));
    await expect(createDevMailer('smtp', { config: noAuth, logger, label: 'dev:erp', mailFromSet: true })).rejects.toThrow(/needs SMTP_USER/);
    const err = await make({ ...SMTP_ENV }, false).catch((e: Error) => e);
    expect(String(err)).not.toContain('not-a-real-password-1');
  });

  it('console mode says the email was NOT sent and never claims delivery', async () => {
    const dev = await createDevMailer('console', { config: loadConfig(testEnv(erp.url, SMTP_ENV)), logger: createLogger('silent'), label: 'dev:erp', mailFromSet: true });
    expect(dev.mailer).toBeInstanceOf(ConsoleMailer);
    expect(dev.description).toMatch(/CONSOLE.*NOT sent.*--smtp/);
    const printed: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => void printed.push(String(line)));
    try {
      await dev.mailer.send({ to: 'kavya@example.com', subject: 'Confirm your Agrismart email', text: 'link', html: '<p>link</p>' });
    } finally {
      spy.mockRestore();
    }
    expect(printed.join('\n')).toContain('DEV EMAIL');
    expect(printed.join('\n')).not.toMatch(/accepted|delivered|sent to/i);
  });

  it('automated tests use an in-memory mailer even when SMTP settings are present', () => {
    const { services } = buildTestApp(erp.url, { env: SMTP_ENV });
    expect(services.mailer).toBeInstanceOf(MemoryMailer);
    expect(services.mailer).not.toBeInstanceOf(SmtpMailer);
  });
});

describe('registration → verification email (mocked mailer)', () => {
  const person = { name: 'Kavya Rao', email: 'kavya@example.com', phone: '+91 98765 43210', password: 'Green-Fields-2026', confirmPassword: 'Green-Fields-2026' };

  it('a new registration sends exactly one verification email whose link uses APP_PUBLIC_URL', async () => {
    const { app, mailer } = buildTestApp(erp.url, { env: { APP_PUBLIC_URL: 'http://127.0.0.1:5173' } });
    const send = vi.spyOn(mailer, 'send');
    expect((await request(app).post('/api/customer/auth/register').set('Origin', ALLOWED_ORIGIN).send(person)).status).toBe(202);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const msg = send.mock.calls[0]![0];
    expect(msg).toMatchObject({ to: 'kavya@example.com', subject: 'Confirm your Agrismart email address' });
    expect(msg.text).toMatch(/http:\/\/127\.0\.0\.1:5173\/verify-email#token=[A-Za-z0-9_-]{43}/);
  });

  it('a duplicate registration gets the same response and a privacy-safe notice instead of a second verification', async () => {
    const { app, mailer } = buildTestApp(erp.url);
    const first = await request(app).post('/api/customer/auth/register').set('Origin', ALLOWED_ORIGIN).send(person);
    const second = await request(app).post('/api/customer/auth/register').set('Origin', ALLOWED_ORIGIN).send({ ...person, name: 'Someone Else' });
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    await vi.waitFor(() => expect(mailer.outbox).toHaveLength(2));
    expect(mailer.outbox.map((m) => m.subject)).toEqual(['Confirm your Agrismart email address', 'Your Agrismart account']);
    expect(mailer.outbox[1]!.text).not.toMatch(/verify-email#token=/);
  });

  it('verification accepts the emailed token once and rejects invalid and expired tokens', async () => {
    const { app, mailer, repos } = buildTestApp(erp.url);
    await request(app).post('/api/customer/auth/register').set('Origin', ALLOWED_ORIGIN).send(person);
    await vi.waitFor(() => expect(mailer.outbox).toHaveLength(1));
    const token = mailer.outbox[0]!.text.match(/#token=([A-Za-z0-9_-]{43})/)![1]!;
    const verify = (t: string) => request(app).post('/api/customer/auth/verify-email').set('Origin', ALLOWED_ORIGIN).send({ token: t });
    expect((await verify('A'.repeat(43))).status).toBe(400);
    expect((await verify(token)).status).toBe(200);
    expect((await verify(token)).status).toBe(400); // single use

    const other = buildTestApp(erp.url);
    await request(other.app).post('/api/customer/auth/register').set('Origin', ALLOWED_ORIGIN).send(person);
    await vi.waitFor(() => expect(other.mailer.outbox).toHaveLength(1));
    const expired = other.mailer.outbox[0]!.text.match(/#token=([A-Za-z0-9_-]{43})/)![1]!;
    for (const t of other.repos.customerTokens.rows) t.expiresAt = new Date(Date.now() - 1000);
    const res = await request(other.app).post('/api/customer/auth/verify-email').set('Origin', ALLOWED_ORIGIN).send({ token: expired });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_token');
    expect([...repos.customers.rows.values()][0]!.emailVerified).toBe(true);
  });

  it('a mail transport failure is logged (codes only) and does not change the response', async () => {
    const { app, mailer, logs } = buildTestApp(erp.url);
    mailer.fail = true;
    expect((await request(app).post('/api/customer/auth/register').set('Origin', ALLOWED_ORIGIN).send(person)).status).toBe(202);
    await vi.waitFor(() => expect(logs.lines.join('')).toContain('Failed to send account email'));
    const line = logs.lines.find((l) => l.includes('Failed to send account email'))!;
    expect(JSON.parse(line)).toMatchObject({ kind: 'verify_email', err: { name: 'Error' } });
    expect(line).not.toContain('kavya@example.com');
    expect(line).not.toMatch(/token=/);
  });
});
