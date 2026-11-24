/**
 * Read-only ERPNext integration check. It never creates, updates or submits anything, and it
 * never prints the API key or secret.
 *
 *   npm run build && npm run erpnext:verify
 *
 * The checks live in src/integrations/erpnext/verify.ts. With ERPNEXT_PRICE_SYNC=false the price
 * checks are reported as SKIP and the catalogue load runs without any Item Price access.
 * Only the ERPNext settings are needed; MongoDB is not contacted.
 */
import dotenv from 'dotenv';
import { ConfigError, loadConfig } from '../config/env.js';
import { verifyErpnext } from '../integrations/erpnext/verify.js';

dotenv.config({ quiet: true });
// The script never connects to MongoDB; a placeholder lets it run with only ERPNext settings.
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:1/erpnext-verify-unused';

async function main() {
  const { erpnext } = loadConfig();
  const ok = await verifyErpnext(erpnext, { priceListSet: Boolean(process.env.ERPNEXT_PRICE_LIST?.trim()) });
  process.exit(ok ? 0 : 1);
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) console.error(`Configuration problems:\n - ${err.problems.join('\n - ')}`);
  else console.error('verify failed:', err instanceof Error ? err.message : 'unknown error');
  process.exit(1);
});
