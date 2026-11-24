/**
 * Pure pricing helpers. All money arithmetic is done in integer minor units (paise)
 * so totals never drift because of floating point rounding.
 */

export interface ItemPriceRow {
  itemCode: string;
  rate: number;
  currency: string;
  uom: string | null;
  validFrom: string | null; // YYYY-MM-DD
  validUpto: string | null; // YYYY-MM-DD
  customer: string | null;
  batchNo: string | null;
}

export interface Price {
  amount: number;
  currency: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date (YYYY-MM-DD) in the ERPNext site's timezone. */
export function todayInTimezone(timezone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export const toMinor = (amount: number): number => Math.round(amount * 100);
export const fromMinor = (minor: number): number => minor / 100;

/**
 * Select the public selling price for an item from rows of the configured price list.
 * Rules (mirroring ERPNext's own selection, without guessing conversions):
 *  - customer-specific and batch-specific prices are never shown publicly;
 *  - the price must be valid today (valid_from <= today <= valid_upto);
 *  - the price UOM must match the item's stock UOM (or be blank); no UOM conversion is guessed;
 *  - the currency must match the price list currency;
 *  - when several rows qualify, the most recent valid_from wins.
 */
export function selectValidPrice(
  rows: ItemPriceRow[],
  opts: { stockUom: string; currency: string; today: string },
): Price | null {
  const candidates = rows.filter((r) => {
    if (r.customer || r.batchNo) return false;
    if (!Number.isFinite(r.rate) || r.rate <= 0) return false;
    if (r.currency !== opts.currency) return false;
    if (r.uom && r.uom !== opts.stockUom) return false;
    if (r.validFrom && (!DATE.test(r.validFrom) || r.validFrom > opts.today)) return false;
    if (r.validUpto && (!DATE.test(r.validUpto) || r.validUpto < opts.today)) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.validFrom ?? '').localeCompare(a.validFrom ?? ''));
  const best = candidates[0]!;
  return { amount: fromMinor(toMinor(best.rate)), currency: best.currency };
}
