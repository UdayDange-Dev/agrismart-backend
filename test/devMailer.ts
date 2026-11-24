/**
 * Mailer selection for the local dev stacks (`npm run dev:mock`, `npm run dev:erp`).
 *
 *   default                  console: account emails are printed in the terminal, NOT sent
 *   DEV_MAIL_OUTBOX=<file>   file outbox: JSON lines for the Playwright suite, NOT sent
 *   --smtp (explicit opt-in) real SMTP from SMTP_* / MAIL_FROM (Backend/.env for dev:erp);
 *                            connection and login are checked before the API starts
 *
 * Real SMTP is refused under a test runner and cannot be combined with the file outbox, so the
 * automated suites can never send real email. Nothing here prints credentials, recipients or
 * tokens.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import type { Logger } from 'pino';
import type { Config } from '../src/config/env.js';
import { isTestRuntime } from '../src/integrations/erpnext/writeGuard.js';
import { ConsoleMailer, describeMailError, SmtpMailer, type Mailer, type MailMessage } from '../src/services/mailer.js';

export type DevMailMode = 'console' | 'outbox' | 'smtp';

export class DevMailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevMailError';
  }
}

/** Decides the mode from the command line and environment. Throws on unsafe or ambiguous input. */
export function selectDevMailMode(argv: readonly string[], env: NodeJS.ProcessEnv): DevMailMode {
  const smtp = argv.includes('--smtp');
  const outbox = env.DEV_MAIL_OUTBOX?.trim();
  if (smtp && isTestRuntime(env)) throw new DevMailError('--smtp is refused under a test runner: automated tests never send real email');
  if (smtp && outbox) throw new DevMailError('--smtp cannot be combined with DEV_MAIL_OUTBOX (the browser-test outbox)');
  if (smtp) return 'smtp';
  return outbox ? 'outbox' : 'console';
}

/** Writes emails to a JSON-lines file so automated browser tests can follow the links. */
export class FileOutboxMailer implements Mailer {
  constructor(private readonly file: string) {
    writeFileSync(this.file, '');
  }
  async send(message: MailMessage): Promise<void> {
    appendFileSync(this.file, `${JSON.stringify({ to: message.to, subject: message.subject, text: message.text, at: Date.now() })}\n`);
  }
}

/**
 * Wraps the SMTP mailer to say, in the terminal, when the server ACCEPTED a message: only the
 * subject, never the recipient, link or token. Acceptance is not inbox delivery.
 */
export class ReportingSmtpMailer implements Mailer {
  constructor(
    private readonly inner: Mailer,
    private readonly label: string,
    private readonly print: (line: string) => void = (line) => console.log(line),
  ) {}
  async send(message: MailMessage): Promise<void> {
    await this.inner.send(message); // a failure propagates and is logged (codes only) by the caller
    this.print(`[${this.label}] SMTP server ACCEPTED "${message.subject}" (recipient hidden). Not yet proof of inbox delivery.`);
  }
}

export interface DevMailer {
  mode: DevMailMode;
  mailer: Mailer;
  /** One line for the startup banner: proves which mailer is active. No secrets. */
  description: string;
}

/**
 * Builds the mailer for `mode`. In SMTP mode the configuration is validated and the server's
 * connection and login are checked (no email is sent) before the API starts.
 */
export async function createDevMailer(
  mode: DevMailMode,
  input: { config: Config; logger: Logger; label: string; mailFromSet: boolean; outbox?: string; extraCa?: string; print?: (line: string) => void },
): Promise<DevMailer> {
  if (mode === 'outbox') {
    return { mode, mailer: new FileOutboxMailer(input.outbox!), description: 'Account emails: FILE OUTBOX (browser tests) - NOT sent' };
  }
  if (mode === 'console') {
    return {
      mode,
      mailer: new ConsoleMailer(input.logger),
      description: 'Account emails: CONSOLE - printed in this terminal, NOT sent. Add --smtp to send them through SMTP_* in Backend/.env',
    };
  }
  const smtp = input.config.mail.smtp;
  if (!smtp) throw new DevMailError('--smtp needs SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER and SMTP_PASS (Backend/.env)');
  if (!smtp.user) throw new DevMailError('--smtp needs SMTP_USER and SMTP_PASS for the remote mail server');
  if (!input.mailFromSet) throw new DevMailError('--smtp needs MAIL_FROM set to the mailbox address (e.g. Agrismart <shop@your-domain>)');
  const smtpMailer = new SmtpMailer(smtp, input.config.mail.from, input.extraCa);
  try {
    await smtpMailer.verify(); // connect + TLS + login only
  } catch (err) {
    smtpMailer.close();
    throw new DevMailError(`SMTP connection/login failed ${JSON.stringify(describeMailError(err))}; nothing was sent`);
  }
  return {
    mode,
    mailer: new ReportingSmtpMailer(smtpMailer, input.label, input.print),
    description: `Account emails: SMTP ${smtp.host}:${smtp.port} (${smtp.secure ? 'implicit TLS' : 'STARTTLS'}) - connection and login OK - REAL emails will be sent`,
  };
}
