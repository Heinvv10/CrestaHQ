import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { DeliveryError, deliverCommunity, deliverDownload } from "@/lib/server/entitlement-delivery";
import { confirmationDownloads } from "@/lib/server/order-confirmation-service";
import type { Entitlement } from "@/types/entitlements";
import type { Order, OrderDeliverySnapshot } from "@/types/orders";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * Delivers what a paid product order bought: community access or a download
 * link. Reads the order's delivery snapshot, never the live product, and
 * ignores the Sell online gate (a paid buyer is always fulfilled). Failures
 * are recorded on the entitlement, the order and the contact, never thrown.
 *
 * One path for both rails: `finishPaidProductLinkOrder` (Stripe and Paystack)
 * calls it after the order is PAID. The entitlement id `orderId_productId` and
 * the claim below are what stop a replay or two concurrent confirmations
 * granting twice. The claim transaction re-reads the order, so a refund or a
 * hold that lands after the caller read it still stops the grant.
 */

/** A claim older than this is treated as a run that died, and may be retaken. */
const CLAIM_LEASE_MS = 2 * 60_000;

type Delivery = OrderDeliverySnapshot["delivery"];

export function entitlementId(orderId: string, productId: string): string {
  return `${orderId}_${productId}`;
}

/** Only express buy links deliver; invoices, deposits and community orders carry their own effects. */
export function orderDelivers(order: Pick<Order, "source">): boolean {
  return order.source === "product_link";
}

/**
 * Whether the order, as it stands, is owed its delivery: paid (or only partly
 * refunded), not held, and not flagged for a person. A resolved flag
 * (`attentionOpen === false`) no longer blocks, so staff can re-send once they
 * have looked.
 */
export function orderDeliverable(order: Order): boolean {
  if (!orderDelivers(order)) return false;
  if (order.status !== "paid" && order.status !== "partially_refunded") return false;
  if (order.heldAt) return false;
  if (order.attention && order.attentionOpen !== false) return false;
  return true;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface GrantSummary {
  delivered: number;
  failed: number;
  skipped: number;
}

/**
 * Grant every delivery on a paid order. `resend` re-runs deliveries that
 * already succeeded (staff "Re-send delivery"): community grants are
 * idempotent, so only the email goes out again. The order is read here, not
 * passed in, so the grant sees the contact and the state as they are now.
 */
export async function grantForOrder(
  target: { orderId: string; subAccountId: string },
  opts: { resend?: boolean } = {},
): Promise<GrantSummary> {
  const summary: GrantSummary = { delivered: 0, failed: 0, skipped: 0 };
  const db = getAdminDb();
  const snap = await db.doc(`orders/${target.orderId}`).get();
  if (!snap.exists) return summary;
  const order = { id: snap.id, ...(snap.data() as Omit<Order, "id">) };
  if (order.subAccountId !== target.subAccountId) return summary;
  if (!orderDeliverable(order)) return summary;

  let sub: Partial<SubAccountDoc> = {};
  try {
    sub = ((await db.doc(`subAccounts/${order.subAccountId}`).get()).data() ??
      {}) as Partial<SubAccountDoc>;
  } catch (err) {
    console.warn(`[entitlements] sub-account read failed order=${order.id}: ${reason(err)}`);
  }
  // The confirmation email already carried these downloads, so don't mail them again.
  const carried =
    !opts.resend && order.confirmationEmail?.state === "sent"
      ? new Set(confirmationDownloads(order).map((d) => d.productId))
      : new Set<string>();
  const errors: string[] = [];

  for (const d of order.deliveries ?? []) {
    const productName =
      order.lineItems.find((li) => li.productId === d.productId)?.name ?? "your purchase";
    const ref = db.doc(`entitlements/${entitlementId(order.id, d.productId)}`);
    let claimed = false;
    let memberId: string | null = null;
    try {
      const claim = await claimDelivery(ref, order, d, productName, !!opts.resend);
      if (claim !== "claimed") {
        summary.skipped += 1;
        continue;
      }
      claimed = true;
      const email = order.buyerEmail?.trim().toLowerCase();
      if (!email) throw new DeliveryError("The order has no buyer email.");
      if (d.delivery.type === "community") {
        const res = await deliverCommunity({
          order,
          sub,
          delivery: d.delivery,
          email,
          productName,
          productId: d.productId,
        });
        memberId = res.memberId;
        if (res.problem) throw new DeliveryError(res.problem);
      } else {
        await deliverDownload({
          order,
          sub,
          delivery: d.delivery,
          email,
          productName,
          skipEmail: carried.has(d.productId),
        });
      }
      await ref.update({
        fulfilment: { state: "done", error: null, at: Date.now(), memberId },
        sends: FieldValue.increment(1),
        // The contact may have been created after the entitlement.
        contactId: order.contactId,
      });
      summary.delivered += 1;
      await writeActivity(
        order,
        "product_delivered",
        deliveredText(productName, d.delivery, email, carried.has(d.productId)),
      );
    } catch (err) {
      const message =
        err instanceof DeliveryError
          ? err.message
          : "Something went wrong delivering it. Try Re-send delivery from Reports > Payments.";
      if (!(err instanceof DeliveryError)) {
        console.error(
          `[entitlements] delivery failed order=${order.id} product=${d.productId}: ${reason(err)}`,
        );
      }
      if (claimed) {
        await ref
          .update({
            fulfilment: { state: "failed", error: message.slice(0, 300), at: Date.now(), memberId },
            contactId: order.contactId,
          })
          .catch((writeErr: unknown) =>
            console.error(
              `[entitlements] failure write failed order=${order.id} product=${d.productId}: ${reason(writeErr)}`,
            ),
          );
      }
      summary.failed += 1;
      errors.push(`${productName}: ${message}`);
      await writeActivity(order, "delivery_failed", `Delivery failed for ${productName}: ${message}`);
    }
  }

  if (summary.delivered + summary.failed > 0) {
    await db
      .doc(`orders/${order.id}`)
      .update({
        deliveryStatus: {
          state: summary.failed > 0 ? "failed" : "done",
          error: errors.length ? errors.join(" ").slice(0, 300) : null,
          at: Date.now(),
        },
      })
      .catch((err: unknown) =>
        console.warn(`[entitlements] order roll-up failed order=${order.id}: ${reason(err)}`),
      );
  }
  return summary;
}

/**
 * Take the delivery for this run, so a staff re-send and a webhook (or a
 * double click) can't both send it. The order is re-read in the same
 * transaction: a refund, hold or flag that landed since the caller read it
 * means no entitlement is created.
 */
async function claimDelivery(
  ref: FirebaseFirestore.DocumentReference,
  order: Order,
  d: OrderDeliverySnapshot,
  productName: string,
  resend: boolean,
): Promise<"claimed" | "skip"> {
  const db = getAdminDb();
  const orderRef = db.doc(`orders/${order.id}`);
  return db.runTransaction(async (tx) => {
    const [orderSnap, snap] = await Promise.all([tx.get(orderRef), tx.get(ref)]);
    if (!orderSnap.exists) return "skip";
    const current = { id: orderSnap.id, ...(orderSnap.data() as Omit<Order, "id">) };
    if (!orderDeliverable(current)) return "skip";
    const sending = { state: "sending", error: null, at: Date.now() };
    if (!snap.exists) {
      tx.create(ref, {
        agencyId: order.agencyId,
        subAccountId: order.subAccountId,
        contactId: order.contactId,
        buyerEmail: order.buyerEmail,
        orderId: order.id,
        productId: d.productId,
        productName,
        delivery: d.delivery,
        status: "active",
        fulfilment: sending,
        sends: 0,
        livemode: order.livemode,
        createdAt: FieldValue.serverTimestamp(),
      });
      return "claimed";
    }
    const e = snap.data() as Entitlement;
    if (e.status === "revoked") return "skip";
    const f = e.fulfilment;
    if (f?.state === "sending" && Date.now() - (f.at ?? 0) < CLAIM_LEASE_MS) return "skip";
    if (f?.state === "done" && !resend) return "skip";
    tx.update(ref, { fulfilment: { ...sending, memberId: f?.memberId ?? null } });
    return "claimed";
  });
}

function deliveredText(
  productName: string,
  delivery: Delivery,
  email: string,
  inConfirmation: boolean,
): string {
  if (delivery.type === "community") {
    return `Delivered ${productName}: community access granted, sign-in link sent to ${email}.`;
  }
  return inConfirmation
    ? `Delivered ${productName}: download link included in the order confirmation to ${email}.`
    : `Delivered ${productName}: download link sent to ${email}.`;
}

async function writeActivity(
  order: Pick<Order, "id" | "contactId">,
  type: "product_delivered" | "delivery_failed" | "delivery_revoked",
  content: string,
): Promise<void> {
  if (!order.contactId) return;
  try {
    await getAdminDb()
      .collection(`contacts/${order.contactId}/activities`)
      .add({
        type,
        content: content.slice(0, 500),
        createdBy: "system",
        meta: { orderId: order.id },
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn(`[entitlements] activity write failed order=${order.id}: ${reason(err)}`);
  }
}

/**
 * Full refund: mark the order's entitlements revoked so they can't be
 * re-sent. Community access is left in place for staff to remove by hand.
 */
export async function revokeForOrder(order: Order): Promise<number> {
  if (!orderDelivers(order) || !order.deliveries?.length) return 0;
  const db = getAdminDb();
  let revoked = 0;
  for (const d of order.deliveries) {
    const ref = db.doc(`entitlements/${entitlementId(order.id, d.productId)}`);
    const changed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const e = snap.data() as Entitlement | undefined;
      if (!snap.exists || e?.status === "revoked" || e?.subAccountId !== order.subAccountId) {
        return null;
      }
      tx.update(ref, { status: "revoked", revokedAt: FieldValue.serverTimestamp() });
      return e;
    });
    if (!changed) continue;
    revoked += 1;
    await writeActivity(
      order,
      "delivery_revoked",
      changed.delivery.type === "community"
        ? `Refunded ${changed.productName}. Their community access was not removed automatically; remove them from the group if needed.`
        : `Refunded ${changed.productName}. The download link was already sent and still works.`,
    );
  }
  return revoked;
}
