import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  LATE_REPLY_HORIZON_MS,
  canSettleResponded,
  inWindow,
  toMs,
  type MysteryShopChannel,
} from "./model";

/**
 * The reply-side transitions of `mysteryShops` (store.ts holds the send side
 * and the timer): what an inbound email, call or WhatsApp may do to a waiting shop.
 * Each is a transaction that re-reads the shop, so concurrent replies, the
 * timer and a sweep settle it once.
 */

/**
 * How a response was seen. `senderAuth` "pass" = the sender is proven: the
 * call we placed being answered, and a WhatsApp reply (the sending number is
 * WhatsApp's own registration, delivered on Meta's signed webhook). "unknown"
 * = taken on trust: every email reply (an email sender is never provable) and
 * a callback's caller ID. Members see unknown as unverified.
 * A reply whose sender FAILED the mail host's checks never settles a shop
 * (recordAuthFailedReply).
 */
export type ResponseVia = {
  responseVia: "email" | "answered" | "callback" | "whatsapp";
  senderAuth: "pass" | "unknown";
};

/**
 * The first response inside the window wins; a missed shop is upgraded only
 * by an in-window one (a late sync), and then responded wins outright: its
 * confirmation and any dispute are cleared.
 */
export async function settleResponded(shopId: string, atMs: number, via: ResponseVia): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`mysteryShops/${shopId}`);
  return db.runTransaction(async (tx) => {
    const shop = (await tx.get(ref)).data();
    if (!shop || !canSettleResponded(shop, atMs)) return false;
    const upgrade = shop.status === "missed" ? { missedConfirmedAt: null, missedConfirmedByUid: null, disputed: false } : {};
    tx.update(ref, { status: "responded", respondedAt: new Date(atMs), responseMs: atMs - toMs(shop.sentAt)!, ...via, ...upgrade });
    return true;
  });
}

/**
 * The first reply, in the window, whose sender failed the mail host's checks
 * (Authentication-Results). It is not a response: the shop keeps waiting, and
 * a later genuine reply settles it. If none comes, the miss is `disputed` —
 * also when the failing reply is synced late, onto a shop already missed
 * (closableShops bounds how late), which also withdraws its confirmation.
 */
export async function recordAuthFailedReply(shopId: string, atMs: number): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`mysteryShops/${shopId}`);
  return db.runTransaction(async (tx) => {
    const shop = (await tx.get(ref)).data();
    const sent = toMs(shop?.sentAt);
    const waiting = shop?.status === "sent" || shop?.status === "missed";
    if (!waiting || shop.authFailedReplyAt != null || sent === null || !inWindow(sent, atMs)) return false;
    // On a missed shop: disputed, and any confirmation withdrawn so the member re-decides with the dispute visible.
    const missed = shop.status === "missed" ? { disputed: true, missedConfirmedAt: null, missedConfirmedByUid: null } : {};
    tx.update(ref, { authFailedReplyAt: new Date(atMs), ...missed });
    return true;
  });
}

/** The first automatic reply on a waiting shop, in the window. Not a response. */
export async function recordAutoReply(shopId: string, atMs: number): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`mysteryShops/${shopId}`);
  return db.runTransaction(async (tx) => {
    const shop = (await tx.get(ref)).data();
    const sent = toMs(shop?.sentAt);
    if (shop?.status !== "sent" || shop.autoReplyAt != null || sent === null || !inWindow(sent, atMs)) return false;
    tx.update(ref, { autoReplyAt: new Date(atMs) });
    return true;
  });
}

/** A sent (or missed) email that bounced never arrived: `failed`, code `bounced`. It was sent, so the slot is kept. */
export async function markBounced(shopId: string): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`mysteryShops/${shopId}`);
  return db.runTransaction(async (tx) => {
    const status = (await tx.get(ref)).data()?.status;
    if (status !== "sent" && status !== "missed") return false;
    tx.update(ref, { status: "failed", failure: { code: "bounced", reason: "The enquiry bounced: it was never delivered." } });
    return true;
  });
}

/**
 * A sent (or missed, or queued with its id) WhatsApp that Meta reported failed was never delivered:
 * `failed`, code `undeliverable`, with Meta's error. It was sent, so the slot
 * is kept. Never public.
 */
export async function markUndeliverable(shopId: string, detail: string | null): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`mysteryShops/${shopId}`);
  return db.runTransaction(async (tx) => {
    const status = (await tx.get(ref)).data()?.status;
    // Queued too: the id is recorded the moment Meta took it, before markSent.
    if (status !== "queued" && status !== "sent" && status !== "missed") return false;
    const reason = `WhatsApp couldn't deliver the enquiry${detail ? ` (${detail})` : ""}.`;
    tx.update(ref, { status: "failed", failure: { code: "undeliverable", reason } });
    return true;
  });
}

/**
 * The business answered a WhatsApp shop with STOP: never a response. The first
 * one, on a waiting or missed shop in its window, is recorded (`optOutAt`) and
 * such a miss can't be confirmed (store.ts `confirmMissed`).
 */
export async function recordOptOut(shopId: string, atMs: number): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`mysteryShops/${shopId}`);
  return db.runTransaction(async (tx) => {
    const shop = (await tx.get(ref)).data();
    const sent = toMs(shop?.sentAt);
    const waiting = shop?.status === "sent" || shop?.status === "missed";
    if (!waiting || shop.optOutAt != null || sent === null || !inWindow(sent, atMs)) return false;
    tx.update(ref, { optOutAt: new Date(atMs) });
    return true;
  });
}

/** The first delivered / read receipt of a WhatsApp shop, at Meta's time. For the member's card only. */
export async function stampDelivery(shopId: string, field: "deliveredAt" | "readAt", atMs: number): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`mysteryShops/${shopId}`);
  return db.runTransaction(async (tx) => {
    const shop = (await tx.get(ref)).data();
    if (!shop || shop[field] != null) return false;
    tx.update(ref, { [field]: new Date(atMs) });
    return true;
  });
}

/**
 * sent / recently missed shops of one channel in a sub-account — what an
 * inbound reply may close. A missed shop past LATE_REPLY_HORIZON_MS cannot be
 * changed by a late reply any more. Equality-only.
 */
export async function closableShops(subAccountId: string, channel: MysteryShopChannel, nowMs = Date.now()) {
  const col = getAdminDb().collection("mysteryShops");
  const snaps = await Promise.all(
    ["sent", "missed"].map((status) =>
      col.where("subAccountId", "==", subAccountId).where("channel", "==", channel).where("status", "==", status).get(),
    ),
  );
  return snaps
    .flatMap((s) => s.docs)
    .filter((d) => d.data()?.status !== "missed" || nowMs - (toMs(d.data()?.sentAt) ?? 0) <= LATE_REPLY_HORIZON_MS);
}
