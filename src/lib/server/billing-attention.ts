import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { AttentionItem } from "@/types/billing";

/**
 * Flagged payments — money that arrived but settled nothing, so a person must
 * act (refund, or reconcile by hand). Two writers already exist:
 *   - `billingEvents` rows of type payment.flagged / subscription.flagged
 *     (agency ↔ sub-account plan billing), and
 *   - `orders.attention` (a sub-account's own Stripe orders).
 * This module is the read side: it lists the unresolved ones and resolves
 * them. The email about a new flag is billing-attention-notify.ts.
 *
 * A billing-event flag's resolution lives in `billingAttention/{flagId}`
 * (server-only, default-deny in rules), apart from the flag row, because the
 * writers overwrite that row on a redelivery. An order's resolution lives on
 * the order (`attentionOpen: false` + `attentionResolved*`), which its flag
 * writer preserves.
 */

export const FLAGGED_BILLING_EVENTS = ["payment.flagged", "subscription.flagged"];

interface Resolver {
  uid: string;
  email: string;
}

const noticeRef = (flagId: string) => getAdminDb().collection("billingAttention").doc(flagId);

export const subscriptionFlagReason = (matches: number) =>
  `A new subscription matches ${matches} workspaces, so it was not linked to any of them.`;

export const billingEventFlagId = (eventDocId: string) => `event-${eventDocId}`;

/**
 * Stable across redeliveries: an order is paid by one checkout and settles
 * exactly one source, so (order, source) names the problem whatever wording
 * the reconciler produced for it this time.
 */
export const orderFlagId = (orderId: string, source: string) => `order-${orderId}-${source}`;

function toMillis(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  const t = v as { toMillis?: () => number } | null | undefined;
  return typeof t?.toMillis === "function" ? t.toMillis() : null;
}

async function resolvedIds(flagIds: string[]): Promise<Set<string>> {
  if (flagIds.length === 0) return new Set();
  const snaps = await getAdminDb().getAll(...flagIds.map(noticeRef));
  return new Set(snaps.filter((s) => s.exists && s.data()?.resolvedAt).map((s) => s.id));
}

function billingEventItem(id: string, data: Record<string, unknown>): AttentionItem {
  const detail = (data.detail ?? {}) as Record<string, unknown>;
  const isSubscription = data.event === "subscription.flagged";
  const candidates = Array.isArray(detail.candidates) ? detail.candidates.map(String) : [];
  return {
    flagId: billingEventFlagId(id),
    orderId: null,
    subAccountId: typeof data.subAccountId === "string" ? data.subAccountId : null,
    candidates,
    reason: isSubscription
      ? subscriptionFlagReason(candidates.length)
      : String(detail.reason ?? "Payment could not be applied."),
    amountCents: typeof detail.amountCents === "number" ? detail.amountCents : null,
    currency: typeof detail.currency === "string" ? detail.currency : null,
    reference: String((isSubscription ? detail.subscriptionId : detail.reference) ?? "") || null,
    createdAtMs: toMillis(data.createdAt),
  };
}

const newestFirst = (a: AttentionItem, b: AttentionItem) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0);

/** Unresolved flagged billing events for every sub-account of one agency. */
export async function listAgencyBillingFlags(agencyId: string): Promise<AttentionItem[]> {
  const snap = await getAdminDb()
    .collection("billingEvents")
    .where("agencyId", "==", agencyId)
    .where("event", "in", FLAGGED_BILLING_EVENTS)
    .get();
  const items = snap.docs.map((d) => billingEventItem(d.id, d.data()));
  const done = await resolvedIds(items.map((i) => i.flagId));
  return items.filter((i) => !done.has(i.flagId)).sort(newestFirst);
}

/** How many open order flags one listing returns. */
const ORDER_FLAG_LIMIT = 100;

/**
 * Open `attention` notes on one sub-account's orders. Two equality filters,
 * so single-field indexes serve it (no composite). Orders flagged before
 * `attentionOpen` existed carry no such field and do not appear here.
 */
export async function listOrderFlags(subAccountId: string): Promise<AttentionItem[]> {
  const snap = await getAdminDb()
    .collection("orders")
    .where("subAccountId", "==", subAccountId)
    .where("attentionOpen", "==", true)
    .limit(ORDER_FLAG_LIMIT)
    .get();
  return snap.docs
    .map((d): AttentionItem => {
      const o = d.data();
      return {
        flagId: orderFlagId(d.id, String(o.source ?? "")),
        orderId: d.id,
        subAccountId,
        candidates: [],
        reason: String(o.attention ?? ""),
        amountCents: typeof o.totalCents === "number" ? o.totalCents : null,
        currency: typeof o.currency === "string" ? o.currency : null,
        reference: (o.stripePaymentIntentId as string | null) ?? (o.stripeCheckoutSessionId as string | null) ?? null,
        createdAtMs: toMillis(o.paidAt) ?? toMillis(o.createdAt),
      };
    })
    .sort(newestFirst);
}

/** First resolution wins; resolving again is a no-op. */
async function markResolved(flagId: string, owner: { agencyId: string; subAccountId: string | null }, by: Resolver) {
  const db = getAdminDb();
  const ref = noticeRef(flagId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.data()?.resolvedAt) return;
    tx.set(
      ref,
      {
        ...owner,
        resolvedAt: FieldValue.serverTimestamp(),
        resolvedByUid: by.uid,
        resolvedByEmail: by.email || null,
      },
      { merge: true },
    );
  });
}

/** False when the flag does not exist or belongs to another agency. */
export async function resolveAgencyBillingFlag(agencyId: string, flagId: string, by: Resolver): Promise<boolean> {
  if (!flagId.startsWith("event-")) return false;
  const snap = await getAdminDb().collection("billingEvents").doc(flagId.slice("event-".length)).get();
  const data = snap.data();
  if (!snap.exists || !data || data.agencyId !== agencyId || !FLAGGED_BILLING_EVENTS.includes(String(data.event))) {
    return false;
  }
  await markResolved(flagId, { agencyId, subAccountId: (data.subAccountId as string | null) ?? null }, by);
  return true;
}

/**
 * Close an order's flag, recording who and when. The note stays on the order
 * (it is the record of what happened); the order row shows it as resolved.
 * False when the order is not this sub-account's or has no open flag.
 */
export async function resolveOrderFlag(subAccountId: string, orderId: string, by: Resolver): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`orders/${orderId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const o = snap.data();
    if (!snap.exists || !o || o.subAccountId !== subAccountId) return false;
    // Already resolved: a double click is a no-op, not an error.
    if (o.attentionOpen !== true) return !!o.attentionResolvedAt;
    tx.update(ref, {
      attentionOpen: false,
      attentionResolvedAt: FieldValue.serverTimestamp(),
      attentionResolvedByUid: by.uid,
      attentionResolvedByEmail: by.email || null,
    });
    return true;
  });
}
