import nodemailer, { type Transporter } from 'nodemailer';
import type { Logger } from 'pino';
import type { Config } from '../config/env.js';
import { escapeHtml } from '../lib/text.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Production mailer. STARTTLS is required when not using implicit TLS; TLS < 1.2 is refused. */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    smtp: NonNullable<Config['mail']['smtp']>,
    private readonly from: string,
    /** Extra trusted CA (tests with a local SMTP server only). Certificate validation stays on. */
    extraCa?: string,
  ) {
    this.transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      requireTLS: !smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, ...(extraCa ? { ca: extraCa } : {}) },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      ...message,
      // Transactional mail: ask auto-responders not to reply.
      headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
    });
  }

  /** Connects and authenticates without sending anything (used by `npm run mail:check`). */
  async verify(): Promise<void> {
    await this.transport.verify();
  }

  close(): void {
    this.transport.close();
  }
}

/**
 * Log-safe description of a mail error. SMTP error messages often echo recipient addresses
 * (e.g. "550 5.1.1 <user@example.com>"), so only codes are kept.
 */
export function describeMailError(err: unknown): Record<string, string | number> {
  const e = (err ?? {}) as { name?: unknown; code?: unknown; responseCode?: unknown; command?: unknown };
  const out: Record<string, string | number> = { name: typeof e.name === 'string' ? e.name : 'Error' };
  if (typeof e.code === 'string') out.code = e.code;
  if (typeof e.responseCode === 'number') out.responseCode = e.responseCode;
  if (typeof e.command === 'string') out.command = e.command.split(' ')[0]!;
  return out;
}

/**
 * Development-only mailer: prints the email to the console so links can be followed
 * locally. Never used in production (configuration requires SMTP there).
 */
export class ConsoleMailer implements Mailer {
  constructor(private readonly logger: Logger) {}
  async send(message: MailMessage): Promise<void> {
    this.logger.warn('DEV MAIL (not sent) - see console output below');
    console.log(`\n----- DEV EMAIL to ${message.to} -----\nSubject: ${message.subject}\n\n${message.text}\n-----------------------------\n`);
  }
}

/** Test mailer that keeps messages in memory. */
export class MemoryMailer implements Mailer {
  readonly outbox: MailMessage[] = [];
  fail = false;
  async send(message: MailMessage): Promise<void> {
    if (this.fail) throw new Error('SMTP unavailable');
    this.outbox.push(message);
  }
}

// ---------- Templates (every dynamic value is HTML-escaped) ----------

function layout(title: string, paragraphs: string[], action?: { label: string; url: string }): { text: string; html: string } {
  const text = [title, '', ...paragraphs, ...(action ? ['', `${action.label}: ${action.url}`] : []), '', '— Agrismart'].join('\n');
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#1d2a1f;line-height:1.5">
<h2 style="color:#2f6b3a">${escapeHtml(title)}</h2>
${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')}
${action ? `<p><a href="${escapeHtml(action.url)}" style="background:#2f6b3a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${escapeHtml(action.label)}</a></p><p style="font-size:12px;color:#5d6b60">If the button does not work, copy this link: ${escapeHtml(action.url)}</p>` : ''}
<p>— Agrismart</p></body></html>`;
  return { text, html };
}

export const templates = {
  verifyEmail(name: string, url: string, hours: number) {
    return {
      subject: 'Confirm your Agrismart email address',
      ...layout(
        `Hello ${name}`,
        [`Please confirm your email address to finish setting up your Agrismart account. This link expires in ${hours} hours and can be used once.`, 'If you did not create an account, you can ignore this email.'],
        { label: 'Confirm email address', url },
      ),
    };
  },
  alreadyRegistered(signInUrl: string, resetUrl: string) {
    return {
      subject: 'Your Agrismart account',
      ...layout(
        'Someone tried to register with this email',
        [
          'An account already exists for this email address, so no new account was created.',
          `If this was you, sign in at ${signInUrl} or reset your password at ${resetUrl}.`,
          'If it was not you, no action is needed. Your account has not been changed.',
        ],
      ),
    };
  },
  resetPassword(name: string, url: string, minutes: number) {
    return {
      subject: 'Reset your Agrismart password',
      ...layout(
        `Hello ${name}`,
        [`We received a request to reset your password. This link expires in ${minutes} minutes and can be used once.`, 'If you did not request this, ignore this email; your password stays the same.'],
        { label: 'Choose a new password', url },
      ),
    };
  },
  passwordChanged(name: string) {
    return {
      subject: 'Your Agrismart password was changed',
      ...layout(`Hello ${name}`, [
        'The password for your Agrismart account was just changed and other signed-in devices were signed out.',
        'If you did not do this, reset your password immediately and contact us.',
      ]),
    };
  },
  changeEmail(name: string, url: string, hours: number) {
    return {
      subject: 'Confirm your new Agrismart email address',
      ...layout(
        `Hello ${name}`,
        [`Confirm this address to make it the new email for your Agrismart account. The link expires in ${hours} hours and can be used once.`],
        { label: 'Confirm new email address', url },
      ),
    };
  },
  emailChanged(name: string, newEmail: string) {
    return {
      subject: 'Your Agrismart email address was changed',
      ...layout(`Hello ${name}`, [
        `The email address for your Agrismart account was changed to ${newEmail}.`,
        'If you did not do this, contact us immediately.',
      ]),
    };
  },
};
