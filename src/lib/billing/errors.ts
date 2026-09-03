/**
 * Client Billing's user-facing error. Lives outside `billing-service.ts` so the
 * provider adapters can throw it without importing the service (which imports
 * them). Re-exported from `@/lib/server/billing-service` for existing callers.
 */
export class BillingError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "BillingError";
    this.status = status;
  }
}
