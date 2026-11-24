import { describe, expect, it } from 'vitest';
import { selectValidPrice, todayInTimezone, type ItemPriceRow } from '../src/services/pricing.js';
import { escapeHtml, htmlToPlainText } from '../src/lib/text.js';

const row = (over: Partial<ItemPriceRow>): ItemPriceRow => ({
  itemCode: 'A',
  rate: 100,
  currency: 'INR',
  uom: 'Nos',
  validFrom: null,
  validUpto: null,
  customer: null,
  batchNo: null,
  ...over,
});
const opts = { stockUom: 'Nos', currency: 'INR', today: '2026-10-10' };

describe('selectValidPrice', () => {
  it('returns a valid price', () => {
    expect(selectValidPrice([row({ rate: 249.5 })], opts)).toEqual({ amount: 249.5, currency: 'INR' });
  });
  it('ignores expired prices', () => {
    expect(selectValidPrice([row({ validUpto: '2026-10-09' })], opts)).toBeNull();
  });
  it('ignores prices that are not yet valid', () => {
    expect(selectValidPrice([row({ validFrom: '2026-10-11' })], opts)).toBeNull();
  });
  it('accepts prices valid exactly on the boundary dates', () => {
    expect(selectValidPrice([row({ validFrom: '2026-10-10', validUpto: '2026-10-10' })], opts)).not.toBeNull();
  });
  it('never exposes customer- or batch-specific prices', () => {
    expect(selectValidPrice([row({ customer: 'VIP', rate: 1 }), row({ batchNo: 'B1', rate: 2 })], opts)).toBeNull();
  });
  it('does not guess UOM conversions or accept another currency', () => {
    expect(selectValidPrice([row({ uom: 'Box' })], opts)).toBeNull();
    expect(selectValidPrice([row({ currency: 'USD' })], opts)).toBeNull();
    expect(selectValidPrice([row({ uom: null })], opts)).not.toBeNull();
  });
  it('rejects zero, negative and non-finite prices', () => {
    expect(selectValidPrice([row({ rate: 0 }), row({ rate: -5 }), row({ rate: Number.NaN })], opts)).toBeNull();
  });
  it('prefers the most recent valid_from', () => {
    const price = selectValidPrice([row({ rate: 100, validFrom: '2026-01-01' }), row({ rate: 120, validFrom: '2026-09-01' })], opts);
    expect(price?.amount).toBe(120);
  });
  it('rejects malformed dates', () => {
    expect(selectValidPrice([row({ validUpto: 'tomorrow' })], opts)).toBeNull();
  });
  it('computes today in the ERPNext timezone', () => {
    // 2026-10-10T20:00Z is already 2026-10-11 in India (UTC+5:30).
    expect(todayInTimezone('Asia/Kolkata', new Date('2026-10-10T20:00:00Z'))).toBe('2026-10-11');
  });
});

describe('text helpers', () => {
  it('escapes HTML special characters', () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">&`)).toBe('&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;');
  });
  it('strips tags and script content from ERPNext descriptions', () => {
    expect(htmlToPlainText('<p>Hello <b>farmer</b></p><script>alert(1)</script>')).toBe('Hello farmer');
  });
});
