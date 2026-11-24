import type { Logger } from 'pino';
import type { InquiryRepository } from '../repositories/types.js';
import { describe } from '../services/catalogService.js';
import { MAX_SYNC_ATTEMPTS, syncInquiry, type LeadGateway } from '../services/leadSync.js';

/**
 * Periodically retries inquiries whose ERPNext sync is pending. Each inquiry is locked
 * before syncing, so overlapping runs (or several app instances) do not double-create Leads.
 */
export function startInquirySyncJob(
  repo: InquiryRepository,
  gateway: LeadGateway,
  intervalMs: number,
  logger: Logger,
): () => void {
  if (intervalMs <= 0) return () => undefined;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const due = await repo.findDueForSync(new Date(), MAX_SYNC_ATTEMPTS, 20);
      for (const inquiry of due) await syncInquiry(repo, gateway, inquiry.id, logger);
    } catch (err) {
      logger.error({ err: describe(err) }, 'Inquiry sync job failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
