/**
 * Sets up the ERPNext side of the E-commerce User registry (roles, custom DocType, number cards,
 * workspace) from erpnext. See erpnext/README.md.
 *
 *   npm run build
 *   npm run erpnext:setup-user-registry                       # plan only: no network access
 *   ERPNEXT_SETUP_API_KEY=… ERPNEXT_SETUP_API_SECRET=… \
 *     npm run erpnext:setup-user-registry                     # read-only: what exists, what is missing
 *   ERPNEXT_SETUP_API_KEY=… ERPNEXT_SETUP_API_SECRET=… \
 *     npm run erpnext:setup-user-registry -- --apply --confirm-host asfsl.sanvidhierp.in
 *
 * The setup key belongs to a person with rights to create DocTypes (e.g. a System Manager), is
 * passed only for this run and is never the website's integration key. The script only creates
 * missing items; it never updates or deletes anything. Keys are never printed.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { ErpNextClient } from '../integrations/erpnext/client.js';
import { loadRegistryArtifacts, runRegistrySetup, setupItems } from '../integrations/erpnext/registrySetup.js';
import { WRITES_DENIED } from '../integrations/erpnext/writeGuard.js';

dotenv.config({ quiet: true });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = resolve(arg('dir') ?? resolve(here, '../../erpnext'));
  const artifacts = loadRegistryArtifacts(dir);
  const apply = process.argv.includes('--apply');

  const base = process.env.ERPNEXT_BASE_URL?.trim();
  const allowed = (process.env.ERPNEXT_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const key = process.env.ERPNEXT_SETUP_API_KEY?.trim();
  const secret = process.env.ERPNEXT_SETUP_API_SECRET?.trim();

  if (!key || !secret) {
    if (apply) {
      console.error('--apply needs ERPNEXT_SETUP_API_KEY and ERPNEXT_SETUP_API_SECRET (a person’s key, not the website key).');
      return 1;
    }
    console.log(`Plan (offline, definitions from ${dir}). Would create, if missing:`);
    for (const item of setupItems(artifacts)) console.log(`  - ${item.doctype}: ${item.name}`);
    console.log('Nothing was sent anywhere. Provide ERPNEXT_SETUP_API_KEY/SECRET to check the site (read-only).');
    return 0;
  }
  if (!base) {
    console.error('ERPNEXT_BASE_URL is not set');
    return 1;
  }
  const baseUrl = new URL(base);
  if (!allowed.includes(baseUrl.hostname.toLowerCase())) {
    console.error('ERPNEXT_BASE_URL host is not in ERPNEXT_ALLOWED_HOSTS');
    return 1;
  }
  if (apply && arg('confirm-host') !== baseUrl.hostname) {
    console.error(`Refusing to write: pass --confirm-host ${baseUrl.hostname} to confirm the target site.`);
    return 1;
  }

  // Writes only with --apply and the confirmed host; the client's runtime guard additionally
  // refuses the production site unless NODE_ENV=production is set explicitly for this run.
  const client = new ErpNextClient({
    baseUrl,
    apiKey: key,
    apiSecret: secret,
    timeoutMs: 20_000,
    writes: apply ? { allowed: true, reason: 'setup --apply with confirmed host' } : WRITES_DENIED,
  });
  console.log(`${apply ? 'APPLY' : 'CHECK (read-only)'} on ${baseUrl.host}`);
  const steps = await runRegistrySetup(client, artifacts, { apply });
  for (const s of steps) console.log(`  ${s.status.padEnd(7)} ${s.doctype}: ${s.name}${s.detail ? ` (${s.detail})` : ''}`);
  if (steps.some((s) => s.status === 'failed')) return 1;
  if (!apply && steps.some((s) => s.status === 'missing')) console.log('Missing items are created only with --apply --confirm-host <host>.');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error('setup failed:', err instanceof Error ? err.message : 'unknown error');
    process.exit(1);
  },
);
