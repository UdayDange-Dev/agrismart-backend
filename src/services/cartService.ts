import type { CatalogService } from './catalogService.js';
import { fromMinor, toMinor } from './pricing.js';
import { unprocessable } from '../lib/errors.js';
import type { OrderLine } from '../repositories/types.js';

export interface Quote {
  lines: OrderLine[];
  currency: string;
  subtotal: number;
  itemCount: number;
}

/**
 * Prices a cart exclusively from the server-side catalogue. Clients only send item
 * codes and quantities; any client-side price is ignored (and rejected by the schema).
 */
export async function quoteCart(catalog: CatalogService, items: { itemCode: string; qty: number }[]): Promise<Quote> {
  const { byCode, currency } = await catalog.getCatalog();

  // Merge duplicate lines so quantity limits cannot be bypassed by splitting.
  const merged = new Map<string, number>();
  for (const { itemCode, qty } of items) merged.set(itemCode, (merged.get(itemCode) ?? 0) + qty);

  const problems: { itemCode: string; reason: string }[] = [];
  const lines: OrderLine[] = [];
  let subtotalMinor = 0;
  for (const [itemCode, qty] of merged) {
    const product = byCode.get(itemCode);
    if (!product) {
      problems.push({ itemCode, reason: 'not_available' });
      continue;
    }
    if (!product.price) {
      problems.push({ itemCode, reason: 'price_unavailable' });
      continue;
    }
    if (qty > 1000) {
      problems.push({ itemCode, reason: 'quantity_too_large' });
      continue;
    }
    const unitMinor = toMinor(product.price.amount);
    const lineMinor = unitMinor * qty;
    subtotalMinor += lineMinor;
    lines.push({ itemCode, name: product.name, uom: product.uom, qty, unitPrice: fromMinor(unitMinor), lineTotal: fromMinor(lineMinor) });
  }
  if (problems.length > 0) throw unprocessable('Some cart items cannot be ordered', { items: problems });

  return { lines, currency, subtotal: fromMinor(subtotalMinor), itemCount: lines.reduce((n, l) => n + l.qty, 0) };
}
