import type { Logger } from 'pino';
import { ErpNextError, type ErpNextClient } from '../integrations/erpnext/client.js';
import { escapeHtml } from '../lib/text.js';
import type { InquiryRecord, InquiryRepository } from '../repositories/types.js';
import { describe } from './catalogService.js';

export const MAX_SYNC_ATTEMPTS = 6;
const LOCK_MS = 2 * 60 * 1000;

export interface LeadGateway {
  findRecentLeadByEmail(email: string, since: Date): Promise<string | null>;
  createLead(inquiry: InquiryRecord): Promise<string>;
  addComment(leadName: string, inquiry: InquiryRecord): Promise<void>;
}

/**
 * Lead creation uses only standard ERPNext Lead fields. `first_name` (v14+) and
 * `lead_name` (v13) are both sent; Frappe ignores fields that do not exist on the doctype.
 * No custom fields or company routing are assumed.
 */
export class ErpNextLeadGateway implements LeadGateway {
  constructor(
    private readonly client: ErpNextClient,
    private readonly opts: { leadSource: string | undefined; addComment: boolean; timezone: string },
  ) {}

  async findRecentLeadByEmail(email: string, since: Date): Promise<string | null> {
    const rows = await this.client.getList('Lead', {
      fields: ['name'],
      filters: [
        ['email_id', '=', email],
        ['creation', '>=', formatInTimezone(since, this.opts.timezone)],
      ],
      limit: 1,
      orderBy: 'creation desc',
    });
    const name = rows[0]?.name;
    return typeof name === 'string' ? name : null;
  }

  async createLead(inquiry: InquiryRecord): Promise<string> {
    const doc: Record<string, unknown> = {
      first_name: inquiry.name,
      lead_name: inquiry.name,
      email_id: inquiry.email,
    };
    if (inquiry.phone) doc.mobile_no = inquiry.phone;
    if (inquiry.company) doc.company_name = inquiry.company;
    if (this.opts.leadSource) doc.source = this.opts.leadSource;
    const created = await this.client.insert('Lead', doc);
    if (typeof created.name !== 'string' || !created.name) {
      throw new ErpNextError('invalid_response', 'Lead created without a name');
    }
    return created.name;
  }

  async addComment(leadName: string, inquiry: InquiryRecord): Promise<void> {
    if (!this.opts.addComment) return;
    // ERPNext renders comment content as HTML, so every user-supplied value is escaped.
    const parts = [
      `<p><strong>Website ${inquiry.kind === 'quotation' ? 'quotation request' : 'inquiry'} ${escapeHtml(inquiry.reference)}</strong></p>`,
      inquiry.productInterest ? `<p>Product interest: ${escapeHtml(inquiry.productInterest)}</p>` : '',
      inquiry.quantity ? `<p>Quantity: ${inquiry.quantity}</p>` : '',
      `<p>${escapeHtml(inquiry.message).replace(/\n/g, '<br>')}</p>`,
    ];
    await this.client.insert('Comment', {
      comment_type: 'Comment',
      reference_doctype: 'Lead',
      reference_name: leadName,
      content: parts.join(''),
    });
  }
}

/** ERPNext stores datetimes as naive values in the site timezone ("YYYY-MM-DD HH:mm:ss"). */
export function formatInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

const backoffMs =(attempt: number) => Math.min(60_000 * 2 ** attempt, 6 * 60 * 60 * 1000);

/**
 * Synchronises one inquiry to ERPNext. Idempotent across retries:
 *  - a lock prevents concurrent workers from syncing the same inquiry;
 *  - once a Lead name is stored it is never created again;
 *  - after an ambiguous failure (timeout) the retry first looks for a Lead already
 *    created for this email since the inquiry was received.
 */
export async function syncInquiry(
  repo: InquiryRepository,
  gateway: LeadGateway,
  inquiryId: string,
  logger: Logger,
  now: () => Date = () => new Date(),
): Promise<'synced' | 'pending' | 'failed' | 'locked'> {
  const inquiry = await repo.claimForSync(inquiryId, now(), LOCK_MS);
  if (!inquiry) return 'locked';
  if (inquiry.syncStatus === 'synced') {
    await repo.updateSync(inquiry.id, { lockedUntil: null });
    return 'synced';
  }

  let leadName = inquiry.erpLeadName;
  try {
    if (!leadName && (inquiry.attempts > 0 || inquiry.lastErrorKind !== null)) {
      leadName = await gateway.findRecentLeadByEmail(inquiry.email, new Date(inquiry.createdAt.getTime() - 60_000));
    }
    if (!leadName) leadName = await gateway.createLead(inquiry);
    // Persist the Lead name immediately so a later failure can never create a duplicate Lead.
    await repo.updateSync(inquiry.id, { erpLeadName: leadName });

    let commentSynced = inquiry.commentSynced;
    if (!commentSynced) {
      try {
        await gateway.addComment(leadName, inquiry);
        commentSynced = true;
      } catch (err) {
        logger.warn({ inquiry: inquiry.reference, err: describe(err) }, 'Lead created but inquiry comment failed');
      }
    }
    await repo.updateSync(inquiry.id, {
      syncStatus: commentSynced ? 'synced' : 'pending',
      commentSynced,
      attempts: inquiry.attempts + 1,
      nextAttemptAt: commentSynced ? null : new Date(now().getTime() + backoffMs(inquiry.attempts)),
      lastErrorKind: null,
      lockedUntil: null,
    });
    logger.info({ inquiry: inquiry.reference, lead: leadName }, 'Inquiry synced to ERPNext');
    return commentSynced ? 'synced' : 'pending';
  } catch (err) {
    const attempts = inquiry.attempts + 1;
    const kind = err instanceof ErpNextError ? err.kind : 'internal';
    // Validation / permission errors will not fix themselves; stop retrying and flag for staff.
    const permanent = kind === 'validation' || kind === 'auth' || attempts >= MAX_SYNC_ATTEMPTS;
    await repo.updateSync(inquiry.id, {
      syncStatus: permanent ? 'failed' : 'pending',
      attempts,
      lastErrorKind: kind,
      nextAttemptAt: permanent ? null : new Date(now().getTime() + backoffMs(attempts)),
      lockedUntil: null,
    });
    logger.warn({ inquiry: inquiry.reference, attempts, err: describe(err) }, 'Inquiry sync to ERPNext failed');
    return permanent ? 'failed' : 'pending';
  }
}
