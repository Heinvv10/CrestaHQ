import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  MAX_TIMER_REQUEUES,
  RESPONSE_WINDOW_MS,
  TIMER_GRACE_MS,
  TIMER_REQUEUE_MS,
  canSettleResponded,
  inWindow,
  toMs,
  type MysteryShopChannel,
} from "./model";

/**
 * The reply-side transitions of `mysteryShops` (store.ts holds the send side
 * and the timer): what an inbound email or call may do to a waiting shop.
 * Each is a transaction that re-reads the shop, so concurrent replies, the
 * timer and a sweep settle it once.
 */

/**
 * How a response was seen. `senderAuth` "pass" = the sender is proven: only
 * the call we placed being answered. "unknown" = taken on trust: every email
 * reply (a From that failed Authentication-Results is refused, but a pass is
 * not provable) and a callback's caller ID. Members see unknown as unverified.
 * A reply whose sender FAILED the mail host's checks never settles a shop
 * (recordAuthFailedReply).
 */
export type ResponseVia = { responseVia: "email" | "answered" | "callback"; senderAuth: "pass" | "unknown" };

/** The first response inside the window wins; a missed shop is upgraded only by an in-window one. */
export async function settleResponded(shopId: string, atMs: number, via: ResponseVia): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`mysteryShops/${shopId}`);
  return db.runTransaction(async (tx) => {
    const shop = (await tx.get(ref)).data();
    if (!shop || !canSettleResponded(shop, atMs)) return false;
    tx.update(ref, { status: "responded", respondedAt: new Date(atMs), responseMs: atMs - toMs(shop.sentAt)!, ...via });
    return true;
  });
}

/**
 * The first reply, in the window, whose sender failed the mail host's checks
 * (Authentication-Results). It is not a response: the shop keeps waiting, and
 * a later genuine reply settles it. If none comes, the miss is `disputed`.
 */
export async function recordAuthFailedReply(shopId: string, atMs: number): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`mysteryShops/${shopId}`);
  return db.runTransaction(async (tx) => {
    const shop = (await tx.get(ref)).data();
    const sent = toMs(shop?.sentAt);
    if (shop?.status !== "sent" || shop.authFailedReplyAt != null || sent === null || !inWindow(sent, atMs)) return false;
    tx.update(ref, { authFailedReplyAt: new Date(atMs) });
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
 * A missed shop older than this cannot be upgraded by a late reply any more:
 * the longest the missed verdict can wait for the mailbox (the timer's grace
 * plus every re-queue) past the window.
 */
const LATE_SYNC_MS = RESPONSE_WINDOW_MS + TIMER_GRACE_MS + MAX_TIMER_REQUEUES * TIMER_REQUEUE_MS;

/** sent / recently missed shops of one channel in a sub-account — what an inbound reply may close. Equality-only. */
export async function closableShops(subAccountId: string, channel: MysteryShopChannel, nowMs = Date.now()) {
  const col = getAdminDb().collection("mysteryShops");
  const snaps = await Promise.all(
    ["sent", "missed"].map((status) =>
      col.where("subAccountId", "==", subAccountId).where("channel", "==", channel).where("status", "==", status).get(),
    ),
  );
  return snaps
    .flatMap((s) => s.docs)
    .filter((d) => d.data()?.status !== "missed" || nowMs - (toMs(d.data()?.sentAt) ?? 0) <= LATE_SYNC_MS);
}
