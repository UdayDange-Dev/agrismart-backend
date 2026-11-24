import type { Logger } from 'pino';
import { randomReference, randomToken, safeEqualHex, sha256 } from '../lib/crypto.js';
import { conflict, notFound } from '../lib/errors.js';
import { DuplicateKeyError, type OrderRecord, type OrderRepository, type OrderStatus } from '../repositories/types.js';
import type { CatalogService } from './catalogService.js';
import { quoteCart } from './cartService.js';

export interface OrderInput {
  customer: OrderRecord['customer'];
  shippingAddress: OrderRecord['shippingAddress'];
  items: { itemCode: string; qty: number }[];
  notes: string | null;
  /** From the authenticated session only. Every new order belongs to a verified customer. */
  customerId: string;
}

/** Customer-facing view: minimal personal data, no internal fields. */
export function toCustomerView(o: OrderRecord) {
  return {
    reference: o.reference,
    status: o.status,
    items: o.items,
    currency: o.currency,
    subtotal: o.subtotal,
    customerName: o.customer.name,
    shippingCity: o.shippingAddress.city,
    createdAt: o.createdAt.toISOString(),
  };
}

/** Allowed manual status transitions performed by staff. */
const TRANSITIONS: Record<Exclude<OrderStatus, 'pending_review'>, OrderStatus[]> = {
  confirmed: ['pending_review'],
  cancelled: ['pending_review', 'confirmed'],
  fulfilled: ['confirmed'],
};

/**
 * Website orders are *order requests*: they are priced server-side, stored for staff
 * review and never submitted to ERPNext or charged automatically.
 */
export class OrderService {
  constructor(
    private readonly repo: OrderRepository,
    private readonly catalog: CatalogService,
    private readonly opts: { priceList: string },
    private readonly logger: Logger,
  ) {}

  /** A replayed Idempotency-Key returns the earlier order, but only to the customer who placed it. */
  private async replay(idempotencyKeyHash: string, customerId: string) {
    const existing = await this.repo.findByIdempotencyKeyHash(idempotencyKeyHash);
    if (!existing) return null;
    if (existing.customerId !== customerId) throw conflict('This Idempotency-Key has already been used.');
    return { order: existing, accessToken: null, duplicate: true };
  }

  async create(input: OrderInput, idempotencyKey?: string) {
    const idempotencyKeyHash = idempotencyKey ? sha256(idempotencyKey) : null;
    if (idempotencyKeyHash) {
      const replayed = await this.replay(idempotencyKeyHash, input.customerId);
      if (replayed) return replayed;
    }

    const quote = await quoteCart(this.catalog, input.items);
    const accessToken = randomToken(32);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const order = await this.repo.create({
          reference: randomReference('AGS'),
          accessTokenHash: sha256(accessToken),
          idempotencyKeyHash,
          customerId: input.customerId,
          customer: input.customer,
          shippingAddress: input.shippingAddress,
          items: quote.lines,
          currency: quote.currency,
          subtotal: quote.subtotal,
          priceList: this.opts.priceList,
          notes: input.notes,
        });
        this.logger.info({ order: order.reference, lines: order.items.length }, 'Order request stored');
        return { order, accessToken, duplicate: false };
      } catch (err) {
        if (!(err instanceof DuplicateKeyError)) throw err;
        if (idempotencyKeyHash) {
          const replayed = await this.replay(idempotencyKeyHash, input.customerId);
          if (replayed) return replayed;
        }
        // Otherwise it was a (very unlikely) reference collision: retry with a new reference.
      }
    }
    throw new Error('Could not allocate a unique order reference');
  }

  /** Ownership check: the caller must present the access token issued at creation. */
  async getForCustomer(reference: string, token: string): Promise<OrderRecord> {
    const order = await this.repo.findByReference(reference);
    // Same response for "missing" and "wrong token" so references cannot be enumerated.
    if (!order || !safeEqualHex(sha256(token), order.accessTokenHash)) throw notFound('Order not found');
    return order;
  }

  async transition(reference: string, to: Exclude<OrderStatus, 'pending_review'>): Promise<OrderRecord> {
    const updated = await this.repo.transitionStatus(reference, TRANSITIONS[to], to);
    if (updated) return updated;
    if (!(await this.repo.findByReference(reference))) throw notFound('Order not found');
    throw conflict(`Order cannot be moved to "${to}" from its current status`);
  }
}
