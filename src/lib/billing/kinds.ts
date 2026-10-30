/**
 * `metadata.kind` discriminators stamped on every Client Billing object at the
 * provider. The webhook router branches on these so agency→client billing can
 * never collide with the legacy per-user subscription or founders flows.
 *
 * Kept in their own module (rather than `billing-service.ts`) so the provider
 * adapters can stamp them without importing the service.
 */

/** metadata.kind for RECURRING plan objects (products, prices, subscriptions). */
export const SUB_ACCOUNT_PLAN_KIND = "subAccountPlan";
/** metadata.kind for ONE-TIME charges (mode:"payment" checkouts). */
export const SUB_ACCOUNT_CHARGE_KIND = "subAccountCharge";
