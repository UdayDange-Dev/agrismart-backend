import type { CustomerRecord } from '../repositories/types.js';
import type { AuthenticatedUser } from '../services/authService.js';

declare global {
  namespace Express {
    interface Locals {
      requestId: string;
      /** Staff (back-office) user. */
      user?: AuthenticatedUser;
      sessionToken?: string;
      /** Signed-in storefront customer. */
      customer?: CustomerRecord;
      customerSessionToken?: string;
      /** Visitor IP established by the origin gate (only set for requests proven to come through the proxy). */
      clientIp?: string;
    }
  }
}

export {};
