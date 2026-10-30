import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { buildPaypalAmountUrl } from "@/lib/paypal/payment-link";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import { getGroupById } from "@/lib/server/community-service";
import { getCourse } from "@/lib/server/community-classroom-service";
import type { Purchase, PurchaseScope } from "@/types/community";
import { hasCardRail } from "@/lib/payments/can-take-payment";
import type { PayPalConfig } from "@/types";
import type { SubAccountDoc } from "@/types/tenancy";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * One-time PayPal purchases for group access or a single course. v1 is
 * manual-reconcile: the member pays via the sub-account's paypal.me link, then
 * a staff admin clicks "Mark paid", which grants access. The doc shape is
 * forward-compatible with Stripe auto-grant (flip status from a webhook).
 */

function purchasesCol(saId: string, groupId: string) {
  return getAdminDb().collection(
    `subAccounts/${saId}/communityGroups/${groupId}/purchases`,
  );
}

export interface RequestPurchaseResult {
  purchaseId: string;
  /** Empty string when PayPal isn't configured — card is the only rail then. */
  paypalUrl: string;
  status: Purchase["status"];
  amountCents: number;
  currency: string;
  /** True when the sub-account can take a card payment for this purchase
   *  (Payments gate on + Stripe connection ready). */
  cardAvailable: boolean;
}

export async function requestPurchaseServerSide(opts: {
  subAccountId: string;
  groupId: string;
  memberId: string;
  scope: PurchaseScope;
  targetId: string;
}): Promise<RequestPurchaseResult> {
  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${opts.subAccountId}`).get();
  const sub = subSnap.data();
  const paypal = sub?.paypalConfig as PayPalConfig | null | undefined;
  // Payments v1: card is a second rail, so EITHER unlocks purchases. Before
  // this, a Stripe-only workspace couldn't sell community access at all
  // because PayPal was mandatory here. See lib/payments/can-take-payment.
  const cardReady = hasCardRail(sub as Partial<SubAccountDoc>);
  if (!paypal?.username && !cardReady) {
    throw new Error(
      "This group hasn't set up payments yet. Contact the group owner.",
    );
  }
  const agencyId = (sub?.agencyId as string) ?? "";

  // Resolve the price for the target.
  let amountCents: number;
  let currency: string;
  if (opts.scope === "group") {
    const group = await getGroupById(opts.subAccountId, opts.groupId);
    if (!group || group.access !== "paid" || !group.priceCents) {
      throw new Error("This group isn't a paid group.");
    }
    amountCents = group.priceCents;
    currency = group.currency ?? "USD";
  } else {
    const course = await getCourse(opts.subAccountId, opts.groupId, opts.targetId);
    if (!course || course.access !== "purchase" || !course.priceCents) {
      throw new Error("This course isn't for sale.");
    }
    amountCents = course.priceCents;
    currency = course.currency ?? "USD";
  }

  // Idempotent: reuse an open pending purchase for the same member + target.
  const existing = await purchasesCol(opts.subAccountId, opts.groupId)
    .where("memberId", "==", opts.memberId)
    .where("scope", "==", opts.scope)
    .where("targetId", "==", opts.targetId)
    .where("status", "==", "pending")
    .limit(1)
    .get();
  if (!existing.empty) {
    const doc = existing.docs[0];
    return {
      purchaseId: doc.id,
      paypalUrl: (doc.data().paypalUrl as string) ?? "",
      status: "pending",
      amountCents: (doc.data().amountCents as number) ?? amountCents,
      currency: (doc.data().currency as string) ?? currency,
      cardAvailable: cardReady,
    };
  }

  // Empty string when PayPal isn't configured — the member pays by card
  // instead. Kept as "" rather than null so the stored shape never changes.
  const paypalUrl = paypal?.username
    ? buildPaypalAmountUrl({ paypal, amount: amountCents / 100, currency })
    : "";

  const ref = await purchasesCol(opts.subAccountId, opts.groupId).add({
    subAccountId: opts.subAccountId,
    agencyId,
    groupId: opts.groupId,
    memberId: opts.memberId,
    scope: opts.scope,
    targetId: opts.targetId,
    amountCents,
    currency,
    paypalUrl,
    status: "pending",
    grantedByUid: null,
    requestedAt: FieldValue.serverTimestamp(),
    paidAt: null,
  });

  return {
    purchaseId: ref.id,
    paypalUrl,
    status: "pending",
    amountCents,
    currency,
    cardAvailable: cardReady,
  };
}

/** Has this member paid for this course? (Drives the unlock check.) */
export async function hasPaidCourse(
  saId: string,
  groupId: string,
  courseId: string,
  memberId: string,
): Promise<boolean> {
  const snap = await purchasesCol(saId, groupId)
    .where("memberId", "==", memberId)
    .where("scope", "==", "course")
    .where("targetId", "==", courseId)
    .where("status", "==", "paid")
    .limit(1)
    .get();
  return !snap.empty;
}

/** Staff: mark a purchase paid and grant the access it bought. */
export async function markPurchasePaidServerSide(opts: {
  subAccountId: string;
  groupId: string;
  purchaseId: string;
  grantedByUid: string;
  /** The Stripe order paying for it, recorded so a redelivery knows its own. */
  paidOrderId?: string;
}): Promise<{
  ok: boolean;
  /** Set when it was already paid: nothing was granted by this call. */
  alreadyPaid?: { paidOrderId: string | null; paidAt: unknown };
}> {
  const db = getAdminDb();
  const ref = purchasesCol(opts.subAccountId, opts.groupId).doc(opts.purchaseId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Purchase not found");
  const purchase = { id: snap.id, ...(snap.data() as Omit<Purchase, "id">) };
  if (purchase.status === "paid") {
    return {
      ok: true,
      alreadyPaid: { paidOrderId: purchase.paidOrderId ?? null, paidAt: purchase.paidAt ?? null },
    };
  }

  // Grant access BEFORE flipping the purchase: the paid status is what makes
  // a retry return early above, so it must be the last write. A failure in
  // between then leaves the purchase pending and a retry finishes the grant
  // (the membership write is a merge, and the member count moves with it).
  if (purchase.scope === "group") {
    const groupRef = db.doc(
      `subAccounts/${opts.subAccountId}/communityGroups/${opts.groupId}`,
    );
    const memRef = groupRef.collection("memberships").doc(purchase.memberId);
    const existing = await memRef.get();
    const wasActive =
      existing.exists && existing.data()!.status === "active";
    // One batch, so the member count moves exactly when the membership turns
    // active — a retry after a failure here sees neither, or both.
    const batch = db.batch();
    batch.set(
      memRef,
      {
        subAccountId: opts.subAccountId,
        agencyId: purchase.agencyId,
        groupId: opts.groupId,
        memberId: purchase.memberId,
        role: "member",
        status: "active",
        points: existing.data()?.points ?? 0,
        level: existing.data()?.level ?? 1,
        joinedAt: existing.data()?.joinedAt ?? FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    if (!wasActive) batch.update(groupRef, { memberCount: FieldValue.increment(1) });
    await batch.commit();
    if (!wasActive) {
      runAfterResponse(() => emitWebhookEvent({
        subAccountId: opts.subAccountId,
        agencyId: purchase.agencyId,
        mode: "live",
        type: "community.member.joined",
        payload: {
          groupId: opts.groupId,
          memberId: purchase.memberId,
          via: "purchase",
        },
      }));
    }
  }
  // scope "course": access is read live from this paid purchase — no extra
  // write needed.

  await ref.update({
    status: "paid",
    paidAt: FieldValue.serverTimestamp(),
    grantedByUid: opts.grantedByUid,
    ...(opts.paidOrderId ? { paidOrderId: opts.paidOrderId } : {}),
  });

  runAfterResponse(() => emitWebhookEvent({
    subAccountId: opts.subAccountId,
    agencyId: purchase.agencyId,
    mode: "live",
    type: "community.purchase.paid",
    payload: {
      purchaseId: purchase.id,
      groupId: opts.groupId,
      memberId: purchase.memberId,
      scope: purchase.scope,
      targetId: purchase.targetId,
      amountCents: purchase.amountCents,
      currency: purchase.currency,
    },
  }));

  return { ok: true };
}
