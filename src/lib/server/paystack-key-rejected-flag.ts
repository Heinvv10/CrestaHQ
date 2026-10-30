import "server-only";

import { notifyFlag } from "@/lib/server/billing-attention-notify";
import type { PaymentAttempt } from "@/types/payment-attempts";

/**
 * Paystack answered 401/403 for a workspace's stored key: the key was revoked
 * or rotated on Paystack's side, so none of its checkouts can be verified. The
 * workspace's admins are emailed ONCE per key (the flag id carries the key's
 * fingerprint; `notifyFlag` creates its claim doc first, so a later run finds
 * it and sends nothing). A key that is replaced and rejected later is a new
 * flag. Never throws.
 */
export async function flagKeyRejected(attempt: PaymentAttempt): Promise<void> {
  console.error(`[paystack/key-rejected] sa=${attempt.subAccountId}: Paystack rejected the stored key (checkouts cannot be verified)`);
  await notifyFlag({
    flagId: `paystack-key-rejected-${attempt.subAccountId}-${attempt.keyFingerprint}`,
    agencyId: attempt.agencyId,
    subAccountId: attempt.subAccountId,
    audience: "subAccountAdmins",
    reason: "Paystack rejected this workspace's secret key, so checkouts cannot be opened or checked and payments may go unrecorded.",
    amountCents: null,
    currency: null,
    reference: null,
    custom: {
      headline: "Paystack rejected your key",
      intro: "Paystack no longer accepts the secret key connected to this workspace. Until the key is fixed, new checkouts for this workspace will fail and any payment already started cannot be checked or recorded here.",
      where: "Reconnect Paystack under Settings → Payments.",
    },
  });
}
