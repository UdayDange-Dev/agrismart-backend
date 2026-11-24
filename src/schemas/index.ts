import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { z } from 'zod';
import { INQUIRY_KINDS, ORDER_STATUSES } from '../repositories/types.js';
import { normalizeLine } from '../lib/text.js';
import { PASSWORD_MAX, passwordProblem } from '../lib/password.js';

/**
 * Every request boundary is validated with these schemas. Objects are `strict`, so
 * unexpected keys (including `__proto__`, `price`, `role`, `$where`...) are rejected.
 */

// Control characters other than tab/newline are never legitimate in form input.
// eslint-disable-next-line no-control-regex -- matching control characters is the purpose of this pattern
const NO_CONTROL = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/;

const line = (min: number, max: number) =>
  z
    .string()
    .regex(NO_CONTROL, 'Contains invalid characters')
    .transform(normalizeLine)
    .pipe(z.string().min(min, `Must be at least ${min} characters`).max(max, `Must be at most ${max} characters`));

const optionalLine = (max: number) =>
  z
    .string()
    .regex(NO_CONTROL, 'Contains invalid characters')
    .transform(normalizeLine)
    .pipe(z.string().max(max))
    .optional()
    .transform((v) => (v ? v : null));

const multiline = (min: number, max: number) =>
  z
    .string()
    .regex(NO_CONTROL, 'Contains invalid characters')
    .transform((v) => v.normalize('NFC').replace(/\r\n?/g, '\n').trim())
    .pipe(z.string().min(min, `Must be at least ${min} characters`).max(max, `Must be at most ${max} characters`));

export const personName = line(2, 100).refine((v) => /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(v), 'Name contains invalid characters');
export const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email('Enter a valid email address'));
export const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9 ()-]{6,18}[0-9]$/, 'Enter a valid phone number')
  .transform((v) => v.replace(/[ ()-]/g, ''))
  .pipe(z.string().min(7).max(16));

/**
 * A customer's mobile number in E.164 form (e.g. +919876543210), or null when it is not a valid
 * number. India is the default region, so local 10-digit numbers are accepted. Uses the full
 * libphonenumber metadata. Shared numbers are allowed (no uniqueness rule is approved).
 */
export function normalizeMobile(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length < 7 || trimmed.length > 24) return null;
  const parsed = parsePhoneNumberFromString(trimmed, 'IN');
  return parsed?.isValid() ? parsed.number : null;
}

/** Account mobile number (registration and profile): validated and stored in E.164. */
export const mobile = z
  .string()
  .regex(NO_CONTROL, 'Contains invalid characters')
  .transform((v, ctx) => {
    const e164 = normalizeMobile(v);
    if (!e164) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid mobile number' });
      return z.NEVER;
    }
    return e164;
  });

/** ERPNext item codes: printable, no path separators abuse, bounded length. */
export const itemCode = z
  .string()
  .min(1)
  .max(140)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._\-/()&+#]*$/u, 'Invalid item code');

export const reference = (prefix: string) => z.string().regex(new RegExp(`^${prefix}-[A-HJ-NP-Z2-9]{10}$`), 'Invalid reference');

export const pagination = {
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
};

export const productListQuery = z.strictObject({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(140).optional(),
  sort: z.enum(['name', 'price_asc', 'price_desc']).default('name'),
  ...pagination,
});

export const itemCodeParams = z.strictObject({ itemCode });

export const cartItems = z
  .array(z.strictObject({ itemCode, qty: z.number().int().min(1).max(1000) }))
  .min(1, 'Cart is empty')
  .max(50, 'Too many cart lines');

export const cartQuoteBody = z.strictObject({ items: cartItems });

/**
 * Inquiries and quotation requests come from signed-in, verified customers only. There is no
 * email field: the reply address is always the account's confirmed email, taken from the session.
 */
export const inquiryBody = z.strictObject({
  kind: z.enum(INQUIRY_KINDS).default('inquiry'),
  name: personName,
  phone: phone.optional(),
  company: optionalLine(140),
  productInterest: itemCode.optional(),
  quantity: z.number().int('Enter a whole number').min(1, 'Must be at least 1').max(100000, 'Must be at most 100000').optional(),
  message: multiline(10, 2000),
  /** Honeypot field rendered invisibly in the form; humans leave it empty. */
  website: z.literal('').optional(),
});

const addressFields = {
  line1: line(3, 200),
  line2: optionalLine(200),
  city: line(2, 100),
  state: line(2, 100),
  postalCode: z.string().trim().regex(/^[A-Za-z0-9 -]{3,12}$/, 'Enter a valid postal code'),
  country: z.literal('India').default('India'),
};

/** A saved address-book entry. */
export const addressBody = z.strictObject({ label: optionalLine(40), ...addressFields });
export const addressParams = z.strictObject({ id: z.uuid('Address not found') });

/** Orders come from signed-in, verified customers; as with inquiries, the email is the account's. */
export const orderBody = z.strictObject({
  customer: z.strictObject({
    name: personName,
    phone,
    company: optionalLine(140),
  }),
  shippingAddress: z.strictObject(addressFields),
  /** Also add this delivery address to the customer's address book. */
  saveAddress: z.boolean().optional(),
  items: cartItems,
  notes: z
    .string()
    .regex(NO_CONTROL, 'Contains invalid characters')
    .max(1000)
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : null)),
  acceptTerms: z.literal(true, { error: 'You must accept the terms' }),
  website: z.literal('').optional(),
});

export const orderParams = z.strictObject({ reference: reference('AGS') });
export const orderTokenHeader = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid order token');
export const idempotencyKeyHeader = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, 'Invalid Idempotency-Key');

export const loginBody = z.strictObject({
  email,
  password: z.string().min(1).max(256),
});

export const adminInquiryQuery = z.strictObject({
  status: z.enum(['pending', 'synced', 'failed']).optional(),
  ...pagination,
});
export const adminOrderQuery = z.strictObject({
  status: z.enum(ORDER_STATUSES).optional(),
  ...pagination,
});
export const inquiryParams = z.strictObject({ reference: reference('INQ') });
export const orderStatusBody = z.strictObject({ status: z.enum(['confirmed', 'cancelled', 'fulfilled']) });
export const registryRetryBody = z.strictObject({
  scope: z.enum(['failed', 'permanent', 'exhausted']).default('failed'),
  /** Optional: one customer (id from the health/failed views). */
  customerId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'Invalid customer id').optional(),
});

/** Base password rules (context rules such as "must not contain your email" are applied too). */
export const passwordPolicy = z.string().superRefine((v, ctx) => {
  const problem = passwordProblem(v);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

// ---------- Customer accounts ----------

const passwordInput = z.string().min(1, 'Please enter a password').max(PASSWORD_MAX);
const tokenString = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'This link is invalid or has expired');
const confirmMatches = (field: string) => (v: Record<string, unknown>, ctx: z.RefinementCtx) => {
  if (v[field] !== v.confirmPassword) {
    ctx.addIssue({ code: 'custom', path: ['confirmPassword'], message: 'Passwords do not match' });
  }
};

/** Note: there is deliberately no role/admin field; strict objects reject any attempt to send one. */
export const registerBody = z
  .strictObject({
    name: personName,
    email,
    phone: mobile,
    password: passwordInput,
    confirmPassword: z.string().max(PASSWORD_MAX),
    website: z.literal('').optional(), // honeypot
  })
  .superRefine((v, ctx) => {
    const problem = passwordProblem(v.password, { email: v.email, name: v.name });
    if (problem) ctx.addIssue({ code: 'custom', path: ['password'], message: problem });
    confirmMatches('password')(v, ctx);
  });

export const customerLoginBody = z.strictObject({ email, password: z.string().min(1).max(256) });
export const tokenBody = z.strictObject({ token: tokenString });
export const forgotPasswordBody = z.strictObject({ email });
export const resetPasswordBody = z
  .strictObject({ token: tokenString, password: passwordInput, confirmPassword: z.string().max(PASSWORD_MAX) })
  .superRefine(confirmMatches('password'));

export const profileUpdateBody = z
  .strictObject({ name: personName.optional(), phone: mobile.optional() })
  .refine((v) => v.name !== undefined || v.phone !== undefined, 'Nothing to update');

export const changePasswordBody = z
  .strictObject({
    currentPassword: z.string().min(1, 'Enter your current password').max(256),
    newPassword: passwordInput,
    confirmPassword: z.string().max(PASSWORD_MAX),
  })
  .superRefine(confirmMatches('newPassword'));

export const changeEmailBody = z.strictObject({
  currentPassword: z.string().min(1, 'Enter your current password').max(256),
  newEmail: email,
});

export const customerOrdersQuery = z.strictObject({ ...pagination });
export const customerInquiriesQuery = z.strictObject({ ...pagination });
