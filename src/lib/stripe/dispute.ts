import "server-only";

// Stub — see publish/README.md. Typed no-op for the buyer's clone.
// The real implementation (chargeback auto-revoke + evidence draft) is
// LeadStack-mothership-only: it's tied to the founders-sale fulfilment
// (GitHub team revoke, `purchases` docs) that buyers don't have. The shared
// Stripe webhook route imports this, so it must export a matching no-op.
export async function handleChargeDispute(_dispute: unknown): Promise<void> {
  return;
}

export function primaryDisputeAlertEmail(): string | null {
  return null;
}
