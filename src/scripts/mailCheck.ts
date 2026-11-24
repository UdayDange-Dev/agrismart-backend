/**
 * SMTP check for operators. By default it ONLY connects and authenticates (no email is sent):
 *
 *   npm run build && npm run mail:check
 *
 * To send one test email (explicit opt-in, e.g. on staging, to a mailbox you control):
 *
 *   npm run mail:check -- --send-to you@yourcompany.example
 *
 * Note: "accepted by the SMTP server" is not proof of inbox delivery; check the mailbox
 * (and its spam folder) and the message headers for SPF/DKIM/DMARC "pass".
 * Secrets (SMTP_PASS) are never printed.
 */
import dotenv from 'dotenv';
import { ConfigError, loadConfig } from '../config/env.js';
import { isTestRuntime } from '../integrations/erpnext/writeGuard.js';
import { email as emailSchema } from '../schemas/index.js';
import { describeMailError, SmtpMailer } from '../services/mailer.js';

dotenv.config({ quiet: true });
// This script only talks to the SMTP server. It never connects to MongoDB (a placeholder lets it
// run with only the mail settings) and never contacts ERPNext (sync forced off for this process,
// so the ERPNext write guard has nothing to object to).
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:1/mail-check-unused';
process.env.ERPNEXT_LEAD_SYNC = 'false';
process.env.ERPNEXT_USER_SYNC = 'false';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  // Automated tests must never reach a real mail server.
  if (isTestRuntime()) {
    console.error('mail:check does not run under a test runner (NODE_ENV=test / Vitest).');
    return 1;
  }
  const config = loadConfig();
  const smtp = config.mail.smtp;
  console.log(`Environment:      ${config.env}`);
  console.log(`Public URL:       ${config.publicUrl.origin}  (used in email links)`);
  console.log(`Sender (from):    ${config.mail.from}`);
  if (!smtp) {
    console.log('SMTP:             NOT CONFIGURED - development prints emails to the console; real delivery is unverified.');
    return 2;
  }
  console.log(`SMTP server:      ${smtp.host}:${smtp.port} (${smtp.secure ? 'implicit TLS (SSL/TLS from connect, no STARTTLS)' : 'STARTTLS required'}, TLS >= 1.2, certificate verified)`);
  console.log(`SMTP auth:        ${smtp.user ? 'username + password set' : 'none'}`);

  const mailer = new SmtpMailer(smtp, config.mail.from);
  try {
    await mailer.verify();
    console.log('Connection/auth:  OK (no email sent)');

    const rawTo = arg('send-to');
    if (rawTo !== undefined) {
      const to = emailSchema.parse(rawTo);
      await mailer.send({
        to,
        subject: 'Agrismart SMTP test',
        text: `This is a test email from the Agrismart server (${config.env}).\nLinks in account emails will point to ${config.publicUrl.origin}.\n`,
        html: `<p>This is a test email from the Agrismart server.</p><p>Links in account emails will point to <strong>${config.publicUrl.origin}</strong>.</p>`,
      });
      console.log('Test email:       ACCEPTED by the SMTP server. Confirm it arrived in the inbox (not spam) and check SPF/DKIM/DMARC results in the headers.');
    }
    return 0;
  } catch (err) {
    console.log(`SMTP check:       FAILED ${JSON.stringify(describeMailError(err))}`);
    return 1;
  } finally {
    mailer.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof ConfigError) console.error(`Configuration problems:\n - ${err.problems.join('\n - ')}`);
    else console.error('mail:check failed:', err instanceof Error ? err.name : 'unknown error');
    process.exit(1);
  },
);
