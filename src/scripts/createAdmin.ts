/**
 * Creates (or resets the password of) a back-office user. No default credentials exist.
 *
 *   ADMIN_PASSWORD='...' npm run create-admin -- --email ops@example.com --role admin
 *
 * The password is read from ADMIN_PASSWORD (or prompted interactively) and never logged.
 */
import { createInterface } from 'node:readline/promises';
import dotenv from 'dotenv';
import { connectMongo, disconnectMongo } from '../db/mongo.js';
import { createLogger } from '../lib/logger.js';
import { createMongoRepositories } from '../repositories/mongo/index.js';
import { DuplicateKeyError, ROLES, type Role } from '../repositories/types.js';
import { email as emailSchema, passwordPolicy } from '../schemas/index.js';
import { hashPassword } from '../services/authService.js';

dotenv.config({ quiet: true });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  const email = emailSchema.parse(arg('email'));
  const role = (arg('role') ?? 'staff') as Role;
  if (!ROLES.includes(role)) throw new Error(`--role must be one of: ${ROLES.join(', ')}`);

  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    password = await rl.question('Password (input is visible; prefer ADMIN_PASSWORD env var): ');
    rl.close();
  }
  const check = passwordPolicy.safeParse(password);
  if (!check.success) throw new Error(check.error.issues.map((i) => i.message).join('; '));

  const logger = createLogger('warn');
  const conn = await connectMongo(uri, logger);
  const repos = createMongoRepositories(conn);
  const passwordHash = await hashPassword(check.data);
  try {
    await repos.users.create({ email, passwordHash, role });
    console.log(`Created ${role} user ${email}`);
  } catch (err) {
    if (!(err instanceof DuplicateKeyError) || !process.argv.includes('--reset-password')) {
      throw err instanceof DuplicateKeyError ? new Error('User exists; pass --reset-password to change the password') : err;
    }
    const user = await repos.users.findByEmail(email);
    await repos.users.updatePassword(user!.id, passwordHash);
    await repos.sessions.deleteBySubject('staff', user!.id);
    console.log(`Password reset for ${email}; existing sessions revoked`);
  } finally {
    await disconnectMongo();
  }
}

main().catch((err: unknown) => {
  console.error('create-admin failed:', err instanceof Error ? err.message : 'unknown error');
  process.exit(1);
});
