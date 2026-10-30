import { toDate } from "@/lib/server/recurring-invoice-cycle";

/** The clock of unpaid Paystack buy-page orders (see paystack-order-expiry.ts). */

export const PAYSTACK_ORDER_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** An attempt Paystack still calls ongoing/pending after this long will not be paid. */
export const STUCK_ATTEMPT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** Rows per read; attempts skipped without asking Paystack do not count as calls. */
export const EXPIRY_PAGE = 100;
/** Pages read per run at most (a bound on reads, not on calls). */
export const EXPIRY_MAX_PAGES = 10;

/** Whether an attempt created at `createdAt` is past `lifetimeMs` (24 h by default) at `now`. */
export function isPastOrderLifetime(createdAt: unknown, now = Date.now(), lifetimeMs = PAYSTACK_ORDER_LIFETIME_MS): boolean {
  const at = toDate(createdAt);
  return !!at && now - at.getTime() >= lifetimeMs;
}
