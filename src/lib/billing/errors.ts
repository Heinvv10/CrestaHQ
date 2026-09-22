/**
 * Client Billing's user-facing error. Lives outside `billing-service.ts` so the
 * provider adapters can throw it without importing the service (which imports
 * them). Re-exported from `@/lib/server/billing-service` for existing callers.
 */
export class BillingError extends Error {
  readonly status: number;
  /**
   * The provider's own HTTP status, when it answered. `status` is what the
   * operator's request gets back (every 4xx collapses to 400); a webhook
   * deciding whether to ask for a redelivery needs the original — a 429 or
   * 401 is worth retrying, a 404 is not. Undefined when it never answered.
   */
  readonly providerStatus?: number;
  constructor(message: string, status = 400, providerStatus?: number) {
    super(message);
    this.name = "BillingError";
    this.status = status;
    this.providerStatus = providerStatus;
  }
}
