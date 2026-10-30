import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import { isEmailSuppressedError } from "@/lib/comms/email-suppression";
import { isSafeSocialUrl } from "@/lib/website/premium";
import type { Order, OrderConfirmationStatus } from "@/types/orders";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * Plain-text order confirmation from the sub-account to the buyer of an
 * express buy link (upstream 1.0.54 F3, pulled forward into F2). Stripe's
 * receipt depends on a setting in the client's Stripe account, so this is the
 * one email a buyer can count on — and the one place a download link reaches
 * them again after the thanks page.
 *
 * Exactly once: `confirmationEmail` is claimed (`sending`) in a transaction
 * that re-reads the order, and only a `paid`, unflagged `product_link` order
 * with no claim yet can be claimed. A held (amount mismatch) or flagged order
 * never gets one. The outcome (`sent` / `failed`) is recorded; a failed send
 * is not retried, so a buyer is never emailed twice. Never throws.
 */

function money(cents: number, currency: string): string {
  const code = currency.toUpperCase();
  try {
    const n = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
    }).format(cents / 100);
    return `${n} ${code}`;
  } catch {
    return `${(cents / 100).toFixed(2)} ${code}`;
  }
}

/** Short, stable reference the buyer can quote back to support. */
export function orderReference(orderId: string): string {
  return orderId.slice(0, 8).toUpperCase();
}

/** Download links this email carries itself; the delivery step then skips its own email for them. */
export function confirmationDownloads(
  order: Order,
): { productId: string; label: string; url: string }[] {
  return (order.deliveries ?? []).flatMap((d) =>
    d.delivery.type === "download" && isSafeSocialUrl(d.delivery.url)
      ? [{ productId: d.productId, label: d.delivery.label?.trim() || "Download", url: d.delivery.url }]
      : [],
  );
}

function nextSteps(order: Order): string {
  const downloads = confirmationDownloads(order);
  if (downloads.length === 0) return "We'll be in touch soon about next steps.";
  return [
    downloads.length === 1 ? "Your download:" : "Your downloads:",
    ...downloads.map((d) => `  ${d.label}: ${d.url}`),
    "",
    "Keep this email so you can download it again later.",
  ].join("\n");
}

export function renderOrderConfirmation(
  order: Order,
  sub: Partial<SubAccountDoc>,
): { subject: string; text: string } {
  const business = sub.name?.trim() || "";
  const items = order.lineItems
    .map((li) => {
      const qty = li.quantity > 1 ? ` x ${li.quantity}` : "";
      return `  ${li.name}${qty}  ${money(li.unitPriceCents * li.quantity, order.currency)}`;
    })
    .join("\n");
  const main = order.lineItems.find((li) => !li.isBump) ?? order.lineItems[0];
  const test = order.livemode === false ? "[Test] " : "";

  const subject = `${test}Order confirmed: ${main?.name ?? "your order"}`;
  // Mailed from the tenant to whatever address the buyer typed, so nothing
  // the buyer typed is echoed back: only our own doc's item names and amounts.
  const text = `Hi,

Thanks for your order${business ? ` with ${business}` : ""}. Your payment went through.

Order reference: ${orderReference(order.id)}

${items}

Total paid: ${money(order.totalCents, order.currency)}

${nextSteps(order)}

Questions about your order? Just reply to this email.
${business ? `\n${business}\n` : ""}`;
  return { subject, text };
}

/** Claims the send, or returns null when this order must not (or no longer
 *  needs to) be confirmed. */
async function claim(orderId: string): Promise<Order | null> {
  const db = getAdminDb();
  const ref = db.doc(`orders/${orderId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const order = { id: snap.id, ...(snap.data() as Omit<Order, "id">) };
    if (
      order.source !== "product_link" ||
      order.status !== "paid" ||
      !!order.heldAt ||
      order.attentionOpen === true ||
      !!order.attention ||
      order.confirmationEmail
    ) {
      return null;
    }
    const sending: OrderConfirmationStatus = { state: "sending", error: null, at: Date.now() };
    tx.update(ref, { confirmationEmail: sending });
    return { ...order, confirmationEmail: sending };
  });
}

async function record(order: Order, ok: boolean, error: string | null): Promise<void> {
  const db = getAdminDb();
  const status: OrderConfirmationStatus = { state: ok ? "sent" : "failed", error, at: Date.now() };
  try {
    await db.doc(`orders/${order.id}`).update({ confirmationEmail: status });
    if (order.contactId) {
      await db.collection(`contacts/${order.contactId}/activities`).add({
        type: ok ? "order_confirmation_sent" : "order_confirmation_failed",
        content: ok
          ? `Order confirmation emailed to ${order.buyerEmail}.`
          : `Order confirmation not sent: ${error}`,
        createdBy: "system",
        meta: { orderId: order.id },
        createdAt: FieldValue.serverTimestamp(),
      });
    }
  } catch (err) {
    console.warn(
      `[order-confirmation] status write failed order=${order.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Sends the confirmation if this order is due one. Returns whether it was sent. */
export async function sendOrderConfirmation(orderId: string): Promise<boolean> {
  let order: Order | null;
  try {
    order = await claim(orderId);
  } catch (err) {
    console.error(
      `[order-confirmation] claim failed order=${orderId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
  if (!order) return false;

  const email = order.buyerEmail?.trim().toLowerCase() || null;
  if (!email) {
    await record(order, false, "The order has no buyer email.");
    return false;
  }
  try {
    const snap = await getAdminDb().doc(`subAccounts/${order.subAccountId}`).get();
    const sub = (snap.data() ?? {}) as Partial<SubAccountDoc>;
    if (!emailIsConfigured(sub)) {
      await record(order, false, "Email sending isn't set up for this workspace.");
      return false;
    }
    const { subject, text } = renderOrderConfirmation(order, sub);
    await sendEmail({
      to: email,
      from: tenantFrom(sub),
      subAccount: sub,
      // Buyer replies should reach the business, not the shared sender.
      replyTo: sub.replyToEmail?.trim() || sub.accountContact?.email?.trim() || undefined,
      meter: { subAccountId: order.subAccountId },
      contactId: order.contactId ?? undefined,
      subject,
      text,
    });
  } catch (err) {
    const reason = isEmailSuppressedError(err)
      ? "The buyer's address is on this workspace's suppression list."
      : "The email provider refused the send.";
    console.error(
      `[order-confirmation] send failed order=${order.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    await record(order, false, reason);
    return false;
  }
  await record(order, true, null);
  return true;
}
