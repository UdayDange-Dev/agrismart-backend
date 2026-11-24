import type { Logger } from 'pino';
import { randomReference, sha256 } from '../lib/crypto.js';
import { tooManyRequests } from '../lib/errors.js';
import { DuplicateKeyError, type InquiryKind, type InquiryRecord, type InquiryRepository } from '../repositories/types.js';
import { syncInquiry, type LeadGateway } from './leadSync.js';
import { todayInTimezone } from './pricing.js';

export const MAX_INQUIRIES_PER_EMAIL_PER_DAY = 3;

export interface InquiryInput {
  /** From the authenticated session only. */
  customerId: string;
  /** The account's confirmed email, from the session (never from the request body). */
  email: string;
  kind: InquiryKind;
  name: string;
  phone?: string | undefined;
  company: string | null;
  productInterest?: string | undefined;
  quantity?: number | undefined;
  message: string;
}

/** Customer-facing view of their own inquiry: no CRM internals or sync errors. */
export function toCustomerInquiryView(i: InquiryRecord) {
  return {
    reference: i.reference,
    kind: i.kind,
    productInterest: i.productInterest,
    quantity: i.quantity,
    message: i.message,
    status: i.syncStatus === 'synced' ? ('forwarded' as const) : ('received' as const),
    createdAt: i.createdAt.toISOString(),
  };
}

export interface InquiryResult {
  reference: string;
  duplicate: boolean;
  /** `synced`: Lead exists in ERPNext. `queued`: stored locally, sync will be retried. */
  crmSync: 'synced' | 'queued';
}

export class InquiryService {
  constructor(
    private readonly repo: InquiryRepository,
    private readonly gateway: LeadGateway,
    private readonly opts: { timezone: string; leadSync?: boolean },
    private readonly logger: Logger,
  ) {}

  private dedupeKey(input: InquiryInput): string {
    const normalized = input.message.toLowerCase().replace(/\s+/g, ' ').trim();
    return sha256(`${input.email}\n${normalized}\n${todayInTimezone(this.opts.timezone)}`);
  }

  async submit(input: InquiryInput): Promise<InquiryResult> {
    const dedupeKey = this.dedupeKey(input);
    const existing = await this.repo.findByDedupeKey(dedupeKey);
    if (existing) return this.result(existing, true);

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    if ((await this.repo.countByEmailSince(input.email, since)) >= MAX_INQUIRIES_PER_EMAIL_PER_DAY) {
      throw tooManyRequests('You have already sent several inquiries today. Our team will contact you soon.');
    }

    let inquiry: InquiryRecord;
    try {
      inquiry = await this.repo.create({
        reference: randomReference('INQ'),
        customerId: input.customerId,
        kind: input.kind,
        name: input.name,
        email: input.email,
        phone: input.phone ?? null,
        company: input.company,
        productInterest: input.productInterest ?? null,
        quantity: input.quantity ?? null,
        message: input.message,
        dedupeKey,
      });
    } catch (err) {
      // A concurrent identical submission won the race; return that one.
      if (err instanceof DuplicateKeyError) {
        const winner = await this.repo.findByDedupeKey(dedupeKey);
        if (winner) return this.result(winner, true);
      }
      throw err;
    }
    this.logger.info({ inquiry: inquiry.reference }, 'Inquiry stored');

    // With ERPNEXT_LEAD_SYNC=false nothing is written to ERPNext; the inquiry stays queued and is
    // synced by the background job once Lead sync is enabled again.
    if (this.opts.leadSync === false) return { reference: inquiry.reference, duplicate: false, crmSync: 'queued' };
    const status = await syncInquiry(this.repo, this.gateway, inquiry.id, this.logger);
    return { reference: inquiry.reference, duplicate: false, crmSync: status === 'synced' ? 'synced' : 'queued' };
  }

  private result(inquiry: InquiryRecord, duplicate: boolean): InquiryResult {
    return { reference: inquiry.reference, duplicate, crmSync: inquiry.syncStatus === 'synced' ? 'synced' : 'queued' };
  }
}
