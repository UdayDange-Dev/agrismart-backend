import { Router } from 'express';
import type { Logger } from 'pino';
import type { Config } from '../config/env.js';
import { ErpNextError, type ImageResult } from '../integrations/erpnext/client.js';
import { badRequest, notFound } from '../lib/errors.js';
import { csrfProtect, loadCustomerSession, requireVerifiedCustomer } from '../middleware/auth.js';
import { limiter, originCheck } from '../middleware/security.js';
import type { CustomerAuthService } from '../services/customerAuthService.js';
import {
  cartQuoteBody,
  idempotencyKeyHeader,
  inquiryBody,
  itemCodeParams,
  orderBody,
  orderParams,
  orderTokenHeader,
  productListQuery,
} from '../schemas/index.js';
import { quoteCart } from '../services/cartService.js';
import { inCategory } from '../services/categories.js';
import { describe, toPublicProduct, type CatalogService } from '../services/catalogService.js';
import type { InquiryService } from '../services/inquiryService.js';
import { toCustomerView, type OrderService } from '../services/orderService.js';

export interface ImageFetcher {
  fetchPublicImage(path: string): Promise<ImageResult>;
}

/** Bounded in-memory image cache so the image proxy cannot be used to hammer ERPNext. */
class ImageCache {
  private readonly entries = new Map<string, { value: ImageResult; expires: number }>();
  constructor(private readonly maxEntries = 200, private readonly ttlMs = 30 * 60 * 1000) {}
  get(key: string): ImageResult | null {
    const e = this.entries.get(key);
    if (!e || e.expires < Date.now()) return null;
    return e.value;
  }
  set(key: string, value: ImageResult): void {
    if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
  }
}

export function catalogRouter(deps: { catalog: CatalogService; images: ImageFetcher; logger: Logger }): Router {
  const router = Router();
  const imageCache = new ImageCache();

  router.get('/products', async (req, res) => {
    const query = productListQuery.parse(req.query);
    const { products } = await deps.catalog.getCatalog();
    const q = query.q?.toLowerCase();
    // Plain substring matching only: user input is never compiled into a RegExp or DB query.
    let rows = products.filter(
      (p) =>
        // A category matches its whole Item Group subtree (case-insensitive, exact names only).
        (!query.category || inCategory(p, query.category)) &&
        (!q || p.name.toLowerCase().includes(q) || p.itemCode.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)),
    );
    if (query.sort !== 'name') {
      const dir = query.sort === 'price_asc' ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        if (!a.price) return 1;
        if (!b.price) return -1;
        return (a.price.amount - b.price.amount) * dir;
      });
    }
    const start = (query.page - 1) * query.pageSize;
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({
      items: rows.slice(start, start + query.pageSize).map(toPublicProduct),
      total: rows.length,
      page: query.page,
      pageSize: query.pageSize,
    });
  });

  router.get('/categories', async (_req, res) => {
    const { categories } = await deps.catalog.getCatalog();
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ items: categories });
  });

  router.get('/products/:itemCode', async (req, res) => {
    const { itemCode } = itemCodeParams.parse(req.params);
    const product = (await deps.catalog.getCatalog()).byCode.get(itemCode);
    if (!product) throw notFound('Product not found');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(toPublicProduct(product));
  });

  router.get('/products/:itemCode/image', async (req, res) => {
    const { itemCode } = itemCodeParams.parse(req.params);
    const product = (await deps.catalog.getCatalog()).byCode.get(itemCode);
    // The image path comes from ERPNext data for a known product, never from the request.
    if (!product?.imagePath) throw notFound('Image not found');
    let image = imageCache.get(product.imagePath);
    if (!image) {
      try {
        image = await deps.images.fetchPublicImage(product.imagePath);
      } catch (err) {
        deps.logger.warn({ itemCode, err: describe(err) }, 'Product image unavailable');
        throw notFound(err instanceof ErpNextError ? 'Image not found' : 'Image unavailable');
      }
      imageCache.set(product.imagePath, image);
    }
    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Disposition', 'inline');
    res.send(image.body);
  });

  return router;
}

export function commerceRouter(deps: {
  config: Config;
  catalog: CatalogService;
  inquiries: InquiryService;
  orders: OrderService;
  customers: CustomerAuthService;
}): Router {
  const router = Router();
  const { rateLimits } = deps.config;

  router.post('/cart/quote', limiter(rateLimits.cartQuote, 'cart'), async (req, res) => {
    const { items } = cartQuoteBody.parse(req.body);
    res.json(await quoteCart(deps.catalog, items));
  });

  // Buying, inquiries and quotation requests need a signed-in customer with a confirmed email.
  // These are cookie-authenticated writes, so Origin and the session-bound CSRF token are both
  // mandatory, and the customer's id and email always come from the session, never the body.
  const verifiedCustomer = [
    originCheck(deps.config.corsAllowedOrigins, { requireOrigin: true }),
    loadCustomerSession(deps.config, deps.customers),
    csrfProtect('customer'),
    requireVerifiedCustomer,
  ];

  router.post('/inquiries', limiter(rateLimits.inquiries, 'inquiries'), ...verifiedCustomer, async (req, res) => {
    const input = inquiryBody.parse(req.body);
    const customer = res.locals.customer!;
    const result = await deps.inquiries.submit({ ...input, customerId: customer.id, email: customer.email });
    if (!result.duplicate) await deps.customers.noteActivity(customer.id);
    const what = input.kind === 'quotation' ? 'quotation request' : 'inquiry';
    res.status(result.duplicate ? 200 : 202).json({
      reference: result.reference,
      duplicate: result.duplicate,
      status: 'received',
      crmSync: result.crmSync,
      message:
        result.crmSync === 'synced'
          ? `Thank you. Your ${what} has been received and passed to our sales team.`
          : `Thank you. Your ${what} has been received and will be passed to our sales team shortly.`,
    });
  });

  router.post('/orders', limiter(rateLimits.orders, 'orders'), ...verifiedCustomer, async (req, res) => {
    const rawKey = req.headers['idempotency-key'];
    const idempotencyKey = rawKey === undefined ? undefined : idempotencyKeyHeader.parse(rawKey);
    const { saveAddress, ...input } = orderBody.parse(req.body);
    const customer = res.locals.customer!;
    const { order, accessToken, duplicate } = await deps.orders.create(
      { ...input, customer: { ...input.customer, email: customer.email }, customerId: customer.id },
      idempotencyKey,
    );
    if (!duplicate) await deps.customers.noteActivity(customer.id);
    let addressSaved = false;
    if (saveAddress && !duplicate) {
      // A full address book must not fail an order that has already been stored.
      addressSaved = await deps.customers.addAddress(customer.id, { label: null, ...input.shippingAddress }).then(
        () => true,
        () => false,
      );
    }
    res.status(duplicate ? 200 : 201).json({
      order: toCustomerView(order),
      accessToken, // returned once; only its hash is stored
      duplicate,
      addressSaved,
      message: 'Your order request has been received. No payment has been taken; our team will confirm availability, taxes and delivery charges.',
    });
  });

  router.get('/orders/:reference', async (req, res) => {
    const { reference } = orderParams.parse(req.params);
    const token = req.headers['x-order-token'];
    if (typeof token !== 'string') throw badRequest('Order token required');
    const order = await deps.orders.getForCustomer(reference, orderTokenHeader.parse(token));
    res.json(toCustomerView(order));
  });

  return router;
}
