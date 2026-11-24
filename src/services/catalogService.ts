import { z } from 'zod';
import type { Logger } from 'pino';
import { ErpNextClient, ErpNextError, type Filter } from '../integrations/erpnext/client.js';
import { htmlToPlainText } from '../lib/text.js';
import { serviceUnavailable } from '../lib/errors.js';
import { buildCategories, categoryLabel, type CategorySummary, type ItemGroupRow } from './categories.js';
import { selectValidPrice, todayInTimezone, type ItemPriceRow, type Price } from './pricing.js';

export interface Product {
  itemCode: string;
  name: string;
  description: string;
  /** The item's own ERPNext Item Group. */
  category: string;
  /** Item Group path below the root, top-level group first (set by the catalogue service). */
  categoryPath: string[];
  uom: string;
  price: Price | null;
  /** Internal ERPNext path; never sent to clients. */
  imagePath: string | null;
}

export interface PublicProduct {
  itemCode: string;
  name: string;
  description: string;
  category: string;
  categoryLabel: string;
  /** Item Group path, top-level group first, for breadcrumbs and category links. */
  categoryPath: { name: string; label: string }[];
  uom: string;
  price: Price | null;
  imageUrl: string | null;
}

export interface Catalog {
  products: Product[];
  byCode: Map<string, Product>;
  categories: CategorySummary[];
  currency: string;
  loadedAt: number;
}

export interface CatalogSource {
  load(): Promise<Omit<Catalog, 'byCode' | 'categories' | 'loadedAt'> & { itemGroups?: ItemGroupRow[] | null }>;
}

export class CatalogConfigError extends Error {}

export function toPublicProduct(p: Product): PublicProduct {
  return {
    itemCode: p.itemCode,
    name: p.name,
    description: p.description,
    category: p.category,
    categoryLabel: categoryLabel(p.category),
    categoryPath: p.categoryPath.map((name) => ({ name, label: categoryLabel(name) })),
    uom: p.uom,
    price: p.price,
    imageUrl: p.imagePath ? `/api/products/${encodeURIComponent(p.itemCode)}/image` : null,
  };
}

const flag = z.union([z.number(), z.boolean(), z.string()]).transform((v) => v === 1 || v === true || v === '1');
const optStr = z
  .string()
  .nullish()
  .transform((v) => (v && v.trim() ? v.trim() : null));

const priceListRow = z.object({ enabled: flag, selling: flag, currency: z.string().min(1) });
const itemRow = z.object({
  item_code: z.string().min(1).max(140),
  item_name: z.string().min(1).max(300),
  item_group: z.string().nullish(),
  description: z.string().nullish(),
  image: optStr,
  stock_uom: z.string().min(1),
  end_of_life: z.string().nullish(),
});
const websiteItemRow = z.object({
  item_code: z.string().min(1),
  web_item_name: optStr,
  website_image: optStr,
  short_description: optStr,
  web_long_description: optStr,
});
const itemGroupRow = z.object({ name: z.string().min(1).max(140), parent_item_group: z.string().nullish() });
const itemPriceRow = z.object({
  item_code: z.string().min(1),
  price_list_rate: z.number(),
  currency: z.string().min(1),
  uom: optStr,
  valid_from: optStr,
  valid_upto: optStr,
  customer: optStr,
  batch_no: optStr,
});

/** Loads published, enabled, sellable items and their valid prices from ERPNext (read-only). */
export class ErpNextCatalogSource implements CatalogSource {
  constructor(
    private readonly client: ErpNextClient,
    private readonly opts: {
      priceList: string;
      /** false: Price List / Item Price are never requested; every product has price null. */
      priceSync?: boolean;
      catalogSource: 'website_item' | 'item';
      itemGroups: string[];
      timezone: string;
    },
    private readonly logger: Logger,
  ) {}

  /** Validates the configured selling price list and returns its currency. */
  private async priceListCurrency(): Promise<string> {
    const priceListDoc = priceListRow.safeParse(await this.client.getDoc('Price List', this.opts.priceList).catch((err) => {
      if (err instanceof ErpNextError && err.kind === 'not_found') {
        throw new CatalogConfigError(`Price list "${this.opts.priceList}" does not exist in ERPNext`);
      }
      throw err;
    }));
    if (!priceListDoc.success) throw new CatalogConfigError('Price list response was malformed');
    if (!priceListDoc.data.enabled || !priceListDoc.data.selling) {
      throw new CatalogConfigError(`Price list "${this.opts.priceList}" is disabled or not a selling price list`);
    }
    return priceListDoc.data.currency;
  }

  async load() {
    // Without price sync no price is ever read or invented: products are listed with price null
    // ("Ask for price") and cannot be added to an order (the cart rejects unpriced items).
    const priceSync = this.opts.priceSync !== false;
    const currency = priceSync ? await this.priceListCurrency() : '';

    const itemFilters: Filter[] = [
      ['disabled', '=', 0],
      ['is_sales_item', '=', 1],
      ['has_variants', '=', 0], // template items cannot be sold directly
    ];
    if (this.opts.itemGroups.length > 0) itemFilters.push(['item_group', 'in', this.opts.itemGroups]);

    const [rawItems, rawPrices, rawWebItems, rawGroups] = await Promise.all([
      this.client.getAll('Item', {
        fields: ['item_code', 'item_name', 'item_group', 'description', 'image', 'stock_uom', 'end_of_life'],
        filters: itemFilters,
      }),
      priceSync
        ? this.client.getAll('Item Price', {
            fields: ['item_code', 'price_list_rate', 'currency', 'uom', 'valid_from', 'valid_upto', 'customer', 'batch_no'],
            filters: [
              ['price_list', '=', this.opts.priceList],
              ['selling', '=', 1],
            ],
          })
        : Promise.resolve([]),
      this.opts.catalogSource === 'website_item'
        ? this.client.getAll('Website Item', {
            fields: ['item_code', 'web_item_name', 'website_image', 'short_description', 'web_long_description'],
            filters: [['published', '=', 1]],
          })
        : Promise.resolve(null),
      // The category tree is optional: without read access to Item Group the catalogue still loads.
      this.client.getAll('Item Group', { fields: ['name', 'parent_item_group'] }).catch((err: unknown) => {
        this.logger.warn({ err: describe(err) }, 'Item Group tree unavailable; using flat item groups as categories');
        return null;
      }),
    ]);

    let skipped = 0;
    const pricesByItem = new Map<string, ItemPriceRow[]>();
    for (const raw of rawPrices) {
      const r = itemPriceRow.safeParse(raw);
      if (!r.success) {
        skipped++;
        continue;
      }
      const list = pricesByItem.get(r.data.item_code) ?? [];
      list.push({
        itemCode: r.data.item_code,
        rate: r.data.price_list_rate,
        currency: r.data.currency,
        uom: r.data.uom,
        validFrom: r.data.valid_from,
        validUpto: r.data.valid_upto,
        customer: r.data.customer,
        batchNo: r.data.batch_no,
      });
      pricesByItem.set(r.data.item_code, list);
    }

    let webByCode: Map<string, z.infer<typeof websiteItemRow>> | null = null;
    if (rawWebItems) {
      webByCode = new Map();
      for (const raw of rawWebItems) {
        const r = websiteItemRow.safeParse(raw);
        if (r.success) webByCode.set(r.data.item_code, r.data);
        else skipped++;
      }
    }

    let itemGroups: ItemGroupRow[] | null = null;
    if (rawGroups) {
      itemGroups = [];
      for (const raw of rawGroups) {
        const r = itemGroupRow.safeParse(raw);
        if (r.success) itemGroups.push({ name: r.data.name, parent: r.data.parent_item_group?.trim() || null });
        else skipped++;
      }
    }

    const today = todayInTimezone(this.opts.timezone);
    const products: Product[] = [];
    for (const raw of rawItems) {
      const r = itemRow.safeParse(raw);
      if (!r.success) {
        skipped++;
        continue;
      }
      const item = r.data;
      const web = webByCode?.get(item.item_code);
      if (webByCode && !web) continue; // not published on the website
      // Standard ERPNext Item.end_of_life: discontinued items cannot be sold.
      if (item.end_of_life && /^\d{4}-\d{2}-\d{2}$/.test(item.end_of_life) && item.end_of_life < today) continue;
      const imageCandidate = web?.website_image ?? item.image;
      products.push({
        itemCode: item.item_code,
        name: (web?.web_item_name ?? item.item_name).slice(0, 300),
        description: htmlToPlainText(web?.web_long_description ?? web?.short_description ?? item.description ?? ''),
        category: item.item_group?.trim() || 'Other',
        categoryPath: [],
        uom: item.stock_uom,
        price: priceSync ? selectValidPrice(pricesByItem.get(item.item_code) ?? [], { stockUom: item.stock_uom, currency, today }) : null,
        imagePath: ErpNextClient.isPublicFilePath(imageCandidate) ? imageCandidate : null,
      });
    }
    if (skipped > 0) this.logger.warn({ skipped }, 'Skipped malformed ERPNext catalogue rows');
    products.sort((a, b) => a.name.localeCompare(b.name));
    return { products, currency, itemGroups };
  }
}

/** In-memory catalogue cache with single-flight refresh and bounded stale fallback. */
export class CatalogService {
  private current: Catalog | null = null;
  private inflight: Promise<Catalog> | null = null;

  constructor(
    private readonly source: CatalogSource,
    private readonly opts: { ttlMs: number; maxStaleMs: number },
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  invalidate(): void {
    this.current = null;
  }

  async getCatalog(): Promise<Catalog> {
    const age = this.current ? this.now() - this.current.loadedAt : Infinity;
    if (this.current && age < this.opts.ttlMs) return this.current;
    try {
      return await this.refresh();
    } catch (err) {
      if (this.current && age < this.opts.ttlMs + this.opts.maxStaleMs) {
        this.logger.warn({ err: describe(err) }, 'Catalogue refresh failed; serving stale data');
        return this.current;
      }
      this.logger.error({ err: describe(err) }, 'Catalogue unavailable');
      throw serviceUnavailable('Product catalogue is temporarily unavailable');
    }
  }

  private refresh(): Promise<Catalog> {
    this.inflight ??= this.source
      .load()
      .then(({ products, currency, itemGroups }) => {
        const categories = buildCategories(products, itemGroups ?? null);
        const catalog: Catalog = {
          products,
          currency,
          byCode: new Map(products.map((p) => [p.itemCode, p])),
          categories,
          loadedAt: this.now(),
        };
        this.current = catalog;
        return catalog;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}

/** Safe error summary for logs: no stack traces with URLs, no headers. */
export function describe(err: unknown): { name: string; message: string; kind?: string; status?: number } {
  if (err instanceof ErpNextError) return { name: err.name, message: err.message, kind: err.kind, status: err.status };
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: 'Unknown', message: 'Non-error thrown' };
}
