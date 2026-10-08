import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { usageMonthKey } from "@/lib/server/usage-meter";
import {
  OPEN_STATUSES,
  canSettleMissed,
  canSettleResponded,
  RESPONSE_WINDOW_MS,
  inWindow,
  toMs,
  type MysteryShopChannel,
  type MysteryShopFailure,
} from "./model";

/**
 * `mysteryShops` state transitions. The monthly cap lives on the usage ledger
 * like the report quota (`subAccounts/{id}/usage/{month}`, field
 * `mysteryShops`): a shop is charged when it is reserved, in the same
 * transaction that creates it, and a shop that never sent (failed, refused)
 * gives its slot back. Every transition is a transaction that re-reads the
 * shop, so a timer, a reply and a sweep racing each other settle it once.
 * Queries are equality-only, sorted in memory: no composite indexes.
 */

const usedOf = (d: FirebaseFirestore.DocumentData | undefined): number => (d?.mysteryShops as number | undefined) ?? 0;

export async function shopsUsed(subAccountId: string): Promise<number> {
  return usedOf((await getAdminDb().doc(`subAccounts/${subAccountId}/usage/${usageMonthKey()}`).get()).data());
}

export interface ReserveInput {
  agencyId: string;
  subAccountId: string;
  contactId: string;
  reportId: string | null;
  uid: string;
  channel: MysteryShopChannel;
  target: string;
  targetLabel: string;
  /** Email: the target's domain is the business's own, so colleagues' replies count (targets.ts). */
  targetDomainTrusted: boolean;
  enquiryText: string;
  jobValueCents: number;
  currency: string;
  niche: string;
  cap: number;
}

/**
 * Create the shop `queued` and charge the month, atomically. Refuses while the
 * contact has a queued/sent shop on the same channel, then at the cap. Every
 * reservation reads then writes the month's usage doc, so concurrent ones
 * conflict and the retry sees the other's shop. Throws on a Firestore error.
 */
export async function reserveShop(input: ReserveInput): Promise<{ shopId: string } | "shop_in_progress" | "cap_reached"> {
  const db = getAdminDb();
  const usageMonth = usageMonthKey();
  const usageRef = db.doc(`subAccounts/${input.subAccountId}/usage/${usageMonth}`);
  const shopRef = db.collection("mysteryShops").doc();
  const contactShops = db
    .collection("mysteryShops")
    .where("subAccountId", "==", input.subAccountId)
    .where("contactId", "==", input.contactId);
  return db.runTransaction(async (tx) => {
    const used = usedOf((await tx.get(usageRef)).data());
    const existing = await tx.get(contactShops);
    const open = existing.docs.some((d) => d.data()?.channel === input.channel && OPEN_STATUSES.has(d.data()?.status));
    if (open) return "shop_in_progress" as const;
    if (used >= input.cap) return "cap_reached" as const;
    const now = new Date();
    tx.set(usageRef, { mysteryShops: FieldValue.increment(1) }, { merge: true });
    tx.create(shopRef, {
      agencyId: input.agencyId,
      subAccountId: input.subAccountId,
      contactId: input.contactId,
      reportId: input.reportId,
      channel: input.channel,
      target: input.target,
      targetLabel: input.targetLabel,
      targetDomainTrusted: input.targetDomainTrusted,
      status: "queued",
      sentAt: null,
      respondedAt: null,
      responseMs: null,
      autoReplyAt: null,
      jobValueCents: input.jobValueCents,
      currency: input.currency,
      niche: input.niche,
      enquiryText: input.enquiryText,
      providerRef: null,
      failure: null,
      createdByUid: input.uid,
      confirmedAt: now,
      createdAt: now,
      usageMonth,
    });
    return { shopId: shopRef.id };
  });
}

/** queued → sent, with the provider's id. Returns the send time, or null if the shop was no longer queued. */
export async function markSent(shopId: string, providerRef: string): Promise<Date | null> {
  const db = getAdminDb();
  const ref = db.doc(`mysteryShops/${shopId}`);
  return db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).data()?.status !== "queued") return null;
    const sentAt = new Date();
    tx.update(ref, { status: "sent", sentAt, providerRef });
    return sentAt;
  });
}

/**
 * A send whose outcome is unknown — the provider may have taken it (a throw
 * after the provider call, or the sent write failing) — is treated as sent:
 * `sent` with `sendUncertain: true`, the cap slot kept, the 24 h clock
 * running, and the open shop still blocking a second send. With
 * `olderThanMs` (the stuck sweep): only a shop queued that long, dated from
 * its creation.
 */
export async function markUncertain(
  shopId: string,
  providerRef: string | null,
  opts: { olderThanMs?: number } = {},
): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`mysteryShops/${shopId}`);
  return db.runTransaction(async (tx) => {
    const shop = (await tx.get(ref)).data();
    if (shop?.status !== "queued") return false;
    const created = toMs(shop.createdAt);
    if (opts.olderThanMs !== undefined && (created === null || Date.now() - created <= opts.olderThanMs)) return false;
    const sentAt = opts.olderThanMs !== undefined && created !== null ? new Date(created) : new Date();
    tx.update(ref, { status: "sent", sentAt, providerRef, sendUncertain: true });
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
 * A queued shop that never sent → `failed` / `refused` with the reason, and
 * its cap slot back (floored at 0). Anything else is left alone, so a repeat
 * cannot release twice. With `olderThanMs`, only a shop queued that long ago.
 */
export async function releaseShop(
  shopId: string,
  status: "failed" | "refused",
  failure: MysteryShopFailure,
  opts: { olderThanMs?: number } = {},
): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`mysteryShops/${shopId}`);
  return db.runTransaction(async (tx) => {
    const shop = (await tx.get(ref)).data();
    if (shop?.status !== "queued") return false;
    const created = toMs(shop.createdAt);
    if (opts.olderThanMs !== undefined && (created === null || Date.now() - created <= opts.olderThanMs)) return false;
    const usageRef = db.doc(`subAccounts/${shop.subAccountId}/usage/${shop.usageMonth}`);
    const used = usedOf((await tx.get(usageRef)).data());
    tx.update(ref, { status, failure });
    if (typeof shop.usageMonth === "string" && used > 0) tx.set(usageRef, { mysteryShops: used - 1 }, { merge: true });
    return true;
  });
}

/**
 * How a response was seen. `senderAuth` "pass" = the sender is proven: only
 * the call we placed being answered. "unknown" = taken on trust: every email
 * reply (a From that failed Authentication-Results is refused, but a pass is
 * not provable) and a callback's caller ID. Members see unknown as unverified.
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

/**
 * sent + no response + window over → missed. Anything else is a no-op.
 * Returns the status after. An EMAIL shop is only judged once the inbox has
 * been read past the window: the mailbox's last successful sync is at or
 * after sentAt + 24 h and it has no error. Until then it stays `sent`
 * (`awaitingSync: true`) and this returns "awaiting_sync".
 */
export async function settleMissed(shopId: string, nowMs = Date.now()): Promise<string | null> {
  const db = getAdminDb();
  const ref = db.doc(`mysteryShops/${shopId}`);
  return db.runTransaction(async (tx) => {
    const shop = (await tx.get(ref)).data();
    if (!shop) return null;
    if (!canSettleMissed(shop, nowMs)) return shop.status as string;
    if (shop.channel === "email") {
      const mailbox = (await tx.get(db.doc(`subAccounts/${shop.subAccountId}`))).data()?.mailboxConfig;
      const syncedAt = Date.parse(mailbox?.lastSyncAt ?? "");
      if (mailbox?.lastError || !(syncedAt >= toMs(shop.sentAt)! + RESPONSE_WINDOW_MS)) {
        if (shop.awaitingSync !== true) tx.update(ref, { awaitingSync: true });
        return "awaiting_sync";
      }
    }
    tx.update(ref, { status: "missed", awaitingSync: false });
    return "missed";
  });
}

export const MAX_TIMER_REQUEUES = 48;

/** One more hour's wait for a shop awaiting the mailbox sync: the re-queue count, or null past the limit. */
export async function requeueTimer(shopId: string): Promise<number | null> {
  const db = getAdminDb();
  const ref = db.doc(`mysteryShops/${shopId}`);
  return db.runTransaction(async (tx) => {
    const shop = (await tx.get(ref)).data();
    const n = typeof shop?.timerRequeues === "number" ? shop.timerRequeues : 0;
    if (shop?.status !== "sent" || n >= MAX_TIMER_REQUEUES) return null;
    tx.update(ref, { timerRequeues: n + 1 });
    return n + 1;
  });
}

/** A missed shop older than this cannot be upgraded by a late reply any more (the sync lag is far shorter). */
const LATE_SYNC_MS = RESPONSE_WINDOW_MS + 48 * 3600_000;

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
