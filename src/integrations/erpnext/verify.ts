/**
 * Read-only ERPNext integration check used by `npm run erpnext:verify`. It never creates, updates
 * or submits anything, and it never prints the API key or secret.
 *
 * Required checks (result false if any fails): credentials, Item / Item Group read access, the
 * catalogue source and a full catalogue load. With ERPNEXT_PRICE_SYNC=true the selling price
 * list and Item Price read access are required too; with ERPNEXT_PRICE_SYNC=false they are
 * skipped, and the catalogue load is checked to make no Price List / Item Price request at all.
 * Informational checks (never fail the run): Company name, Lead read access, and E-commerce User read
 * access (required, i.e. failing the run, when ERPNEXT_USER_SYNC=true).
 */
import type { Config } from '../../config/env.js';
import { createLogger } from '../../lib/logger.js';
import { buildCategories } from '../../services/categories.js';
import { ErpNextCatalogSource } from '../../services/catalogService.js';
import { REGISTRY_DOCTYPE } from '../../services/userRegistry.js';
import { ErpNextClient, ErpNextError } from './client.js';

const EXPECTED_COMPANY = 'AGRI SMART FARM SOLUTIONS LLP';
const PRICE_DOCTYPES = /^\/api\/resource\/(Item Price|Price List)(\/|$)/;

export interface VerifyOptions {
  /** Whether ERPNEXT_PRICE_LIST was set explicitly (only affects the settings line). */
  priceListSet: boolean;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

function describeError(err: unknown): string {
  if (err instanceof ErpNextError) {
    const hint =
      err.kind === 'auth'
        ? ' (check ERPNEXT_API_KEY / ERPNEXT_API_SECRET and the API user’s role permissions)'
        : err.kind === 'timeout' || err.kind === 'network'
          ? ' (check ERPNEXT_BASE_URL and network access)'
          : '';
    return `${err.kind}${err.status ? ` (HTTP ${err.status})` : ''}: ${err.message}${hint}`;
  }
  return err instanceof Error ? err.message : 'unknown error';
}

/** "kavya@example.com" -> "ka***@example.com": enough to find the user in ERPNext, not the full address. */
export function maskUser(user: string): string {
  const at = user.indexOf('@');
  if (at < 0) return user.length <= 3 ? user : `${user.slice(0, 2)}***`;
  return `${user.slice(0, Math.min(2, at))}***${user.slice(at)}`;
}

/**
 * Read-only least-privilege probe for the API user behind ERPNEXT_API_KEY:
 *  - who is it (masked);
 *  - can it read a DocType *definition*? In Frappe only System Manager / Administrator can, so a
 *    successful read means the user has administrator-level access. Metadata only: no records.
 * Never prints credentials. Confirm the result in the UI (User > Roles), see erpnext/README.md.
 */
export async function checkApiUserPrivilege(client: ErpNextClient): Promise<{ user: string | null; adminLevel: boolean | null; summary: string }> {
  let user: string | null = null;
  try {
    const who = await client.getMethod('frappe.auth.get_logged_user');
    user = typeof who === 'string' ? maskUser(who) : null;
  } catch {
    // reported below
  }
  if (user === 'Ad***' || user === 'Administrator') {
    return { user, adminLevel: true, summary: 'the API key belongs to Administrator' };
  }
  try {
    await client.getDoc('DocType', 'User');
    return { user, adminLevel: true, summary: `API user ${user ?? '(unknown)'} can read DocType definitions, i.e. it has System Manager (or equivalent).` };
  } catch (err) {
    if (err instanceof ErpNextError && err.kind === 'auth') {
      return { user, adminLevel: false, summary: `API user ${user ?? '(unknown)'} cannot read DocType definitions (no System Manager-level access).` };
    }
    return { user, adminLevel: null, summary: `could not determine (${describeError(err)}); check the user's roles in the ERPNext UI.` };
  }
}

const NO_PRICES_HINT = '; if no selling prices are configured in ERPNext yet, set ERPNEXT_PRICE_SYNC=false (products then show "Ask for price")';

export async function verifyErpnext(erpnext: Config['erpnext'], opts: VerifyOptions): Promise<boolean> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const baseFetch = opts.fetchImpl ?? fetch;

  // Price requests are recorded and, when price sync is off, refused locally without reaching
  // ERPNext, so the catalogue check proves the website never needs Item Price access.
  const priceRequests: string[] = [];
  const guardedFetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = decodeURIComponent(url.pathname);
    if (PRICE_DOCTYPES.test(path)) {
      priceRequests.push(path);
      if (!erpnext.priceSync) return Promise.resolve(new Response(null, { status: 403 }));
    }
    return baseFetch(input, init);
  };
  const client = new ErpNextClient({
    baseUrl: erpnext.baseUrl,
    apiKey: erpnext.apiKey,
    apiSecret: erpnext.apiSecret,
    timeoutMs: erpnext.timeoutMs,
    fetchImpl: guardedFetch,
  });

  const step = async (name: string, fn: () => Promise<string>, stepOpts: { optional?: boolean; hint?: (err: unknown) => string } = {}) => {
    try {
      log(`  OK    ${name}: ${await fn()}`);
      return true;
    } catch (err) {
      log(`  ${stepOpts.optional ? 'INFO ' : 'FAIL '} ${name}: ${describeError(err)}${stepOpts.hint?.(err) ?? ''}`);
      return Boolean(stepOpts.optional);
    }
  };
  const priceAuthHint = (err: unknown) => (err instanceof ErpNextError && err.kind === 'auth' ? NO_PRICES_HINT : '');

  log(`Verifying ERPNext at ${erpnext.baseUrl.host} (read-only; no records are created or changed)`);
  const priceSetting = erpnext.priceSync
    ? `price sync ON, price list "${erpnext.priceList}"${opts.priceListSet ? '' : ' (default, ERPNEXT_PRICE_LIST not set)'}`
    : 'price sync OFF (ERPNEXT_PRICE_SYNC=false)';
  log(`  Settings: ${priceSetting}, catalogue source "${erpnext.catalogSource}"`);

  const results: boolean[] = [];
  // Stop early on bad credentials: every later request would fail the same way.
  const authenticated = await step('Credentials', async () => {
    const user = await client.getMethod('frappe.auth.get_logged_user');
    if (typeof user !== 'string' || !user || user === 'Guest') throw new Error('request was not authenticated');
    return `authenticated as API user "${user}"`;
  });
  if (!authenticated) return false;
  results.push(authenticated);

  if (!erpnext.priceSync) {
    log('  SKIP  Selling price lists: price sync is off (ERPNEXT_PRICE_SYNC=false)');
    log('  SKIP  Item Price read: price sync is off; Item Price permission is not needed and products show "Ask for price"');
  } else {
    results.push(
      await step(
        'Selling price lists',
        async () => {
          const lists = await client.getAll('Price List', { fields: ['name', 'currency'], filters: [['enabled', '=', 1], ['selling', '=', 1]] });
          const names = lists.map((l) => `"${String(l.name)}" (${String(l.currency)})`);
          const found = lists.some((l) => l.name === erpnext.priceList);
          if (!found) throw new Error(`configured price list "${erpnext.priceList}" is not among the enabled selling lists: ${names.join(', ') || 'none'}`);
          return `${lists.length} enabled: ${names.join(', ')}; configured "${erpnext.priceList}" found`;
        },
        { hint: priceAuthHint },
      ),
    );

    results.push(
      await step(
        `Item Price read ("${erpnext.priceList}")`,
        async () => {
          const rows = await client.getList('Item Price', {
            fields: ['name'],
            filters: [['price_list', '=', erpnext.priceList], ['selling', '=', 1]],
            limit: 1,
          });
          return rows.length > 0 ? 'readable, prices exist in this list' : 'readable, but this price list has no item prices';
        },
        { hint: priceAuthHint },
      ),
    );
  }

  results.push(
    await step('Item read', async () => {
      const rows = await client.getList('Item', { fields: ['name'], filters: [['disabled', '=', 0], ['is_sales_item', '=', 1]], limit: 1 });
      return rows.length > 0 ? 'readable, enabled sales items exist' : 'readable, but no enabled sales items found';
    }),
  );

  results.push(
    await step(`Catalogue source "${erpnext.catalogSource}"`, async () => {
      if (erpnext.catalogSource === 'item') return 'all enabled sales items are listed (ERPNEXT_ITEM_GROUPS can restrict them)';
      try {
        const rows = await client.getList('Website Item', { fields: ['name'], filters: [['published', '=', 1]], limit: 1 });
        return rows.length > 0 ? 'Website Item available; published items exist' : 'Website Item available, but nothing is published yet';
      } catch (err) {
        if (err instanceof ErpNextError && err.kind === 'not_found') {
          throw new Error('the Website Item doctype does not exist on this site (webshop app not installed); set ERPNEXT_CATALOG_SOURCE=item', { cause: err });
        }
        throw err;
      }
    }),
  );

  results.push(
    await step('Item Group tree (product categories)', async () => {
      const groups = await client.getAll('Item Group', { fields: ['name', 'parent_item_group'] });
      const tree = groups.map((g) => ({ name: String(g.name), parent: g.parent_item_group ? String(g.parent_item_group) : null }));
      const top = buildCategories([], tree).map((c) => c.label);
      return `${groups.length} item groups; ${top.length} top-level: ${top.join(', ')}`;
    }),
  );

  results.push(
    await step(
      'Catalogue load (as the website does it)',
      async () => {
        priceRequests.length = 0;
        const source = new ErpNextCatalogSource(client, { ...erpnext }, createLogger('warn'));
        const { products, currency, itemGroups } = await source.load();
        if (products.length === 0) throw new Error('no products would be shown on the website');
        const categories = buildCategories(products, itemGroups ?? null).filter((c) => c.count > 0).length;
        if (!erpnext.priceSync) {
          if (priceRequests.length > 0) throw new Error(`price sync is off but the loader requested ${[...new Set(priceRequests)].join(', ')}`);
          if (products.some((p) => p.price !== null)) throw new Error('price sync is off but a product has a price');
          return `${products.length} sellable items in ${categories} top-level categories, no Price List / Item Price request made; all shown as "Ask for price"`;
        }
        const priced = products.filter((p) => p.price);
        const samples = priced
          .slice(0, 3)
          .map((p) => `${p.itemCode} = ${p.price!.amount} ${p.price!.currency}`)
          .join('; ');
        return `${products.length} sellable items in ${categories} top-level categories, ${priced.length} with a valid ${currency} price today${samples ? ` (e.g. ${samples})` : ''}`;
      },
      { hint: (err) => (erpnext.priceSync ? priceAuthHint(err) : '') },
    ),
  );

  // Informational: the website does not use Company, but its legal name should match ERPNext.
  await step(
    'Company record (informational)',
    async () => {
      const companies = (await client.getAll('Company', { fields: ['name'] })).map((c) => String(c.name));
      const exact = companies.includes(EXPECTED_COMPANY);
      return `${companies.map((c) => `"${c}"`).join(', ') || 'none'}; "${EXPECTED_COMPANY}" ${exact ? 'matches exactly' : 'is NOT an exact match'}`;
    },
    { optional: true },
  );
  await step(
    'Lead read access (informational; needed only when ERPNEXT_LEAD_SYNC=true)',
    async () => {
      await client.getList('Lead', { fields: ['name'], limit: 1 });
      return `readable; Lead sync is ${erpnext.leadSync ? 'ON (website inquiries will create Leads)' : 'OFF (nothing is written to ERPNext)'}`;
    },
    { optional: true },
  );
  await step(
    `${REGISTRY_DOCTYPE} registry read access (${erpnext.userSync ? 'required: ERPNEXT_USER_SYNC=true' : 'informational; needed only when ERPNEXT_USER_SYNC=true'})`,
    async () => {
      await client.getList(REGISTRY_DOCTYPE, { fields: ['name'], limit: 1 });
      return `readable; user registry sync is ${erpnext.userSync ? 'ON' : 'OFF (nothing is written to ERPNext)'}`;
    },
    { optional: !erpnext.userSync, hint: () => ' (deploy the DocType and role from erpnext first; see erpnext/README.md)' },
  );
  // Least privilege: the website API user must not be System Manager / Administrator. Required
  // (fails the run) when the user-registry sync is on; informational otherwise.
  const privilege = await checkApiUserPrivilege(client);
  results.push(privilege.adminLevel && erpnext.userSync ? false : true);
  log(
    `  ${privilege.adminLevel ? (erpnext.userSync ? 'FAIL ' : 'WARN ') : 'OK   '} API user least privilege: ${privilege.summary}` +
      (privilege.adminLevel ? ' Remove System Manager from this user (erpnext/README.md "Permissions").' : ''),
  );

  const ok = results.every(Boolean);
  log(ok ? 'Result: ERPNext integration is ready.' : 'Result: fix the FAIL items above.');
  return ok;
}
