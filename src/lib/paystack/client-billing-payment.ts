import "server-only";

import {
  SUB_ACCOUNT_CHARGE_KIND,
  SUB_ACCOUNT_PLAN_KIND,
} from "@/lib/billing/kinds";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  verifyPaystackTransaction,
  type PaystackVerifiedTransaction,
} from "@/lib/paystack/billing-api";
import { isNotFound, requestedAmount } from "@/lib/paystack/payment-link-reconciler";
import {
  activateSubAccountPlan,
  chargesCollection,
  markSubAccountChargePaid,
  readBilling,
} from "@/lib/server/billing-lifecycle";
import {
  activationLedgerRef,
  flagBillingPayment,
} from "@/lib/server/billing-payment-ledger";
import type { BillingChargeDoc } from "@/types/billing";

/**
 * A Client Billing plan or charge payment (`charge.success` carrying our
 * metadata), settled only on what Paystack's verify endpoint says.
 *
 * The signature proves the event came from the agency's Paystack account,
 * not that it paid what its metadata names: checkout metadata and amount are
 * set by whoever opens a payment with the agency's public key. So the body is
 * used only for its reference, and the verified transaction must be a success
 * for that reference whose amount and currency cover the plan or charge the
 * metadata names — a plan this workspace is actually assigned, a charge this
 * workspace actually owes.
 *
 * Throws only when Paystack cannot answer (network, 5xx, 429): the route
 * answers 500 and Paystack redelivers. A mismatch is final — nothing is
 * activated or marked paid, the money (which did arrive on the agency's
 * account) is recorded as a `payment.flagged` row in `billingEvents` plus a
 * console.error, and the route answers 200. Nothing reads `billingEvents` in
 * the UI yet; surfacing these flags to the agency is a follow-up.
 */
export async function settleClientBillingPayment(
  reference: string | undefined,
): Promise<void> {
  if (!reference) {
    console.error("[paystack] Client Billing payment without a reference");
    return;
  }
  const tag = `[paystack] ref=${reference}`;

  let tx: PaystackVerifiedTransaction;
  try {
    tx = await verifyPaystackTransaction(reference);
  } catch (err) {
    if (isNotFound(err)) {
      console.error(`${tag} verify: not found on the agency's account`, err);
      return;
    }
    throw err;
  }
  if (tx.status !== "success" || tx.reference !== reference) {
    console.error(`${tag} not settling: status=${tx.status} reference=${tx.reference}`);
    return;
  }

  const metadata = readMetadata(tx.metadata);
  if (metadata.kind === SUB_ACCOUNT_PLAN_KIND) {
    await settlePlan(tx, metadata, tag);
  } else if (metadata.kind === SUB_ACCOUNT_CHARGE_KIND) {
    await settleCharge(tx, metadata, tag);
  } else {
    console.error(`${tag} verified transaction carries no Client Billing metadata`);
  }
}

type Metadata = ReturnType<typeof readMetadata>;

/** Why the verified money does not cover what is owed, or null when it does. */
function amountMismatch(
  tx: PaystackVerifiedTransaction,
  owed: { cents: number | null | undefined; currency: string | null | undefined; exact: boolean },
): string | null {
  const amount = requestedAmount(tx);
  if (typeof owed.cents !== "number") return "nothing owed on record";
  if (owed.exact ? amount !== owed.cents : amount < owed.cents) {
    return `amount=${amount} expected=${owed.cents}`;
  }
  if (tx.amount < amount) return `partial amount=${tx.amount} requested=${amount}`;
  if ((tx.currency ?? "").toUpperCase() !== (owed.currency ?? "").toUpperCase()) {
    return `currency=${tx.currency} expected=${owed.currency}`;
  }
  return null;
}

async function settlePlan(tx: PaystackVerifiedTransaction, metadata: Metadata, tag: string) {
  const { subAccountId, planId } = metadata;
  if (!subAccountId || !planId) {
    console.error(`${tag} plan payment without subAccountId/planId metadata`);
    return;
  }
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!snap.exists) {
    console.error(`${tag} plan payment for missing sub-account ${subAccountId}`);
    return;
  }
  const data = snap.data() as Record<string, unknown>;
  const billing = readBilling(data);
  // A redelivery of a payment that already activated is settled, whatever has
  // happened to the workspace since — checked before the plan and amount,
  // which may have been re-assigned in the meantime and would misread a
  // replay as a mismatch. (`paystackReference` covers pre-ledger activations.)
  if (
    billing?.paystackReference === tx.reference ||
    (await activationLedgerRef("paystack", tx.reference).get()).exists
  ) {
    return;
  }
  const mismatch =
    billing?.planId !== planId
      ? `plan=${planId} assigned=${billing?.planId ?? null}`
      : amountMismatch(tx, { cents: billing.priceCents, currency: billing.currency, exact: false });
  const agencyId = String(data.agencyId ?? "");
  if (mismatch) {
    await flag(tx, { agencyId, subAccountId, kind: "plan", mismatch });
    return;
  }
  // Comped / re-assigned / already active (paid twice) are decided — and
  // flagged — in there, atomically with the ledger row.
  await activateSubAccountPlan({
    subAccountId,
    planId,
    customerId: tx.customer?.customer_code ?? null,
    // Paystack creates the subscription asynchronously; `subscription.create`
    // fills this in. Null here must not clear an id already stored.
    subscriptionId: null,
    provider: "paystack",
    reference: tx.reference,
    amountCents: tx.amount,
    currency: tx.currency ?? null,
  });
}

async function settleCharge(tx: PaystackVerifiedTransaction, metadata: Metadata, tag: string) {
  const { chargeId } = metadata;
  if (!chargeId) {
    console.error(`${tag} charge payment without chargeId metadata`);
    return;
  }
  const snap = await chargesCollection().doc(chargeId).get();
  if (!snap.exists) {
    console.error(`${tag} payment for missing charge ${chargeId}`);
    return;
  }
  const charge = snap.data() as BillingChargeDoc;
  const mismatch =
    charge.subAccountId !== metadata.subAccountId
      ? `charge belongs to sa=${charge.subAccountId}, metadata names sa=${metadata.subAccountId ?? null}`
      : amountMismatch(tx, { cents: charge.amountCents, currency: charge.currency, exact: true });
  if (mismatch) {
    await flag(tx, {
      agencyId: charge.agencyId,
      subAccountId: charge.subAccountId,
      kind: "charge",
      mismatch,
    });
    return;
  }
  // Already-paid (a redelivery) and paid-after-cancel are decided in there.
  await markSubAccountChargePaid({
    chargeId,
    checkoutSessionId: tx.reference,
    // Paystack's transaction id is the payment; there is no separate intent.
    paymentId: tx.id != null ? String(tx.id) : null,
  });
}

/** Money arrived that does not settle what it claims to — see `flagBillingPayment`. */
async function flag(
  tx: PaystackVerifiedTransaction,
  target: { agencyId: string; subAccountId: string; kind: "plan" | "charge"; mismatch: string },
) {
  await flagBillingPayment({
    provider: "paystack",
    reference: tx.reference,
    agencyId: target.agencyId,
    subAccountId: target.subAccountId,
    kind: target.kind,
    reason: target.mismatch,
    amountCents: tx.amount,
    currency: tx.currency ?? null,
  });
}

/**
 * Paystack echoes back whatever metadata we sent, but as JSON it re-parsed —
 * so it can come back as an object, as a string, or not at all. Only strings
 * are read out of it; nothing here trusts its shape.
 */
export function readMetadata(raw: unknown): {
  kind?: string;
  subAccountId?: string;
  planId?: string;
  chargeId?: string;
} {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Paystack sometimes returns the empty string for "no metadata". That is
      // a renewal, not an error, so it falls through to an empty object.
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== "object") return {};
  const obj = parsed as Record<string, unknown>;
  const str = (key: string) =>
    typeof obj[key] === "string" ? (obj[key] as string) : undefined;
  return {
    kind: str("kind"),
    subAccountId: str("subAccountId"),
    planId: str("planId"),
    chargeId: str("chargeId"),
  };
}
