import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { usageMonthKey } from "@/lib/server/usage-meter";
import {
  OPEN_STATUSES,
  canSettleMissed,
  MAX_TIMER_REQUEUES,
  RESPONSE_WINDOW_MS,
  toMs,
  type MysteryShopChannel,
  type MysteryShopFailure,
} from "./model";

/**
 * `mysteryShops` send-side and timer transitions (the reply side is
 * replies.ts). The monthly cap lives on the usage ledger
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
  /** A form shop: the subject and service it types, and who may answer for the business (inbound.ts). */
  form?: { subject: string; service: string; town: string | null; matchDomains: string[]; matchNumbers: string[]; matchAddresses: string[] };
}

/**
 * Create the shop `queued` and charge the month, atomically. Refuses while the
 * contact (for WhatsApp, or the number) has a queued/sent shop on the same
 * channel, then at the cap. Every
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
    // WhatsApp: one open shop per NUMBER too — another contact can carry the same one.
    const sameNumber =
      input.channel === "whatsapp"
        ? await tx.get(
            db.collection("mysteryShops")
              .where("subAccountId", "==", input.subAccountId)
              .where("channel", "==", "whatsapp")
              .where("target", "==", input.target),
          )
        : null;
    const open =
      existing.docs.some((d) => d.data()?.channel === input.channel && OPEN_STATUSES.has(d.data()?.status)) ||
      !!sameNumber?.docs.some((d) => OPEN_STATUSES.has(d.data()?.status));
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
      ...(input.form
        ? {
            formEnquiry: { subject: input.form.subject, service: input.form.service, town: input.form.town },
            matchDomains: input.form.matchDomains,
            matchNumbers: input.form.matchNumbers,
            matchAddresses: input.form.matchAddresses,
          }
        : {}),
    });
    return { shopId: shopRef.id };
  });
}

/**
 * WhatsApp: the send is starting. `sentAt` is stamped before the provider is
 * asked (a WhatsApp Business greeting fires the instant the message lands, so
 * timing from after our own post-send writes would put it before the send).
 * The shop stays queued. The stamp, or null if it was no longer queued.
 */
export async function stampSendStart(shopId: string): Promise<Date | null> {
  const db = getAdminDb();
  const ref = db.doc(`mysteryShops/${shopId}`);
  return db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).data()?.status !== "queued") return null;
    const sentAt = new Date();
    tx.update(ref, { sentAt });
    return sentAt;
  });
}

/**
 * WhatsApp: the provider's message id, the moment it is known — before the
 * send's other writes — so a delivery receipt that arrives first finds the
 * shop (inbound.ts `recordMysteryShopWhatsAppStatus`). Queued shops, first id only.
 */
export async function recordProviderRef(shopId: string, providerRef: string): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`mysteryShops/${shopId}`);
  return db.runTransaction(async (tx) => {
    const shop = (await tx.get(ref)).data();
    if (shop?.status !== "queued" || shop.providerRef != null) return false;
    tx.update(ref, { providerRef });
    return true;
  });
}

/** A send time stamped before the provider was asked (stampSendStart), else now. */
const startedAt = (shop: FirebaseFirestore.DocumentData) => {
  const ms = toMs(shop.sentAt);
  return ms === null ? new Date() : new Date(ms);
};

/** queued → sent, with the provider's id. Returns the send time, or null if the shop was no longer queued. */
export async function markSent(shopId: string, providerRef: string): Promise<Date | null> {
  const db = getAdminDb();
  const ref = db.doc(`mysteryShops/${shopId}`);
  return db.runTransaction(async (tx) => {
    const shop = (await tx.get(ref)).data();
    if (shop?.status !== "queued") return null;
    const sentAt = startedAt(shop);
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
 * its creation. `onlyIf` re-checks the shop inside the transaction.
 */
export async function markUncertain(
  shopId: string,
  providerRef: string | null,
  opts: { olderThanMs?: number; onlyIf?: (shop: FirebaseFirestore.DocumentData) => boolean } = {},
): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`mysteryShops/${shopId}`);
  return db.runTransaction(async (tx) => {
    const shop = (await tx.get(ref)).data();
    if (shop?.status !== "queued" || (opts.onlyIf && !opts.onlyIf(shop))) return false;
    const created = toMs(shop.createdAt);
    if (opts.olderThanMs !== undefined && (created === null || Date.now() - created <= opts.olderThanMs)) return false;
    const sentAt = toMs(shop.sentAt) === null && opts.olderThanMs !== undefined && created !== null ? new Date(created) : startedAt(shop);
    tx.update(ref, { status: "sent", sentAt, providerRef, sendUncertain: true });
    return true;
  });
}

/**
 * The provider's id for a shop the stuck sweep already marked uncertain
 * (before the send route could record it), so an answered call can still
 * settle it. Only fills a missing id on an uncertain shop.
 */
export async function attachProviderRef(shopId: string, providerRef: string): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`mysteryShops/${shopId}`);
  return db.runTransaction(async (tx) => {
    const shop = (await tx.get(ref)).data();
    if (shop?.sendUncertain !== true || shop.providerRef != null) return false;
    tx.update(ref, { providerRef });
    return true;
  });
}

/**
 * A queued shop that never sent → `failed` / `refused` with the reason, and
 * its cap slot back (floored at 0). Anything else is left alone, so a repeat
 * cannot release twice. With `olderThanMs`, only a shop queued that long ago;
 * `onlyIf` re-checks the shop inside the transaction.
 */
export async function releaseShop(
  shopId: string,
  status: "failed" | "refused",
  failure: MysteryShopFailure,
  opts: { olderThanMs?: number; onlyIf?: (shop: FirebaseFirestore.DocumentData) => boolean } = {},
): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`mysteryShops/${shopId}`);
  return db.runTransaction(async (tx) => {
    const shop = (await tx.get(ref)).data();
    if (shop?.status !== "queued" || (opts.onlyIf && !opts.onlyIf(shop))) return false;
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
 * sent + no response + window over → missed. Anything else is a no-op.
 * Returns the status after. An EMAIL shop is only judged once the INBOX has
 * been read past the window: `mailboxConfig.inboxCaughtUpAt` (the start of a
 * sync pass that read the INBOX to its end) is at or after sentAt + 24 h and
 * the mailbox has no error (a form shop likewise: its reply comes by email). Until then it stays `sent` (`awaitingSync: true`)
 * and this returns "awaiting_sync". A miss after a reply that failed the
 * sender check is flagged `disputed` for the member who decides whether to
 * confirm it (only a confirmed miss is public). A WHATSAPP shop first reads
 * its thread row: failed there → `failed` / undeliverable (returns "failed");
 * delivered / read → stamped as the delivery evidence a confirmation needs; an
 * inbound row from the target since the send → `replyNeedsReview`.
 */
export async function settleMissed(shopId: string, nowMs = Date.now()): Promise<string | null> {
  const db = getAdminDb();
  const ref = db.doc(`mysteryShops/${shopId}`);
  // Outside the transaction (a query there would contend with every inbound
  // write): any inbound row from the target inside the window. If the thread
  // can't be read, the miss is flagged for review rather than trusted.
  const before = (await ref.get()).data();
  const inboundReply = inboundFromTarget(before).catch((err) => {
    console.error("[prospecting/mystery-shop] thread check failed", shopId, err);
    return true;
  });
  return db.runTransaction(async (tx) => {
    const shop = (await tx.get(ref)).data();
    if (!shop) return null;
    if (!canSettleMissed(shop, nowMs)) return shop.status as string;
    // WhatsApp: the thread is evidence too. Our message's row failed = never
    // delivered, so never a miss; delivered/read = proof for the member who
    // confirms (stamped now when no receipt reached the shop itself). An
    // inbound row from the target after the send is a reply the matcher may
    // have lost: the miss needs the member to read the thread first.
    if (shop.channel === "whatsapp") {
      const hasRef = typeof shop.providerRef === "string" && shop.providerRef !== "";
      const thread = `contacts/${shop.contactId}/whatsappMessages`;
      const row = hasRef ? (await tx.get(db.doc(`${thread}/${shop.providerRef}`))).data() : undefined;
      if (row?.status === "failed") {
        const detail = typeof row.error === "string" && row.error ? ` (${row.error})` : "";
        tx.update(ref, { status: "failed", failure: { code: "undeliverable", reason: `WhatsApp couldn't deliver the enquiry${detail}.` } });
        return "failed";
      }
      const seen = new Date(nowMs);
      const evidence = shop.deliveredAt != null || shop.readAt != null;
      const replied = await inboundReply;
      tx.update(ref, {
        status: "missed",
        awaitingSync: false,
        ...((row?.status === "delivered" || row?.status === "read") && !evidence ? { deliveredAt: seen } : {}),
        ...(row?.status === "read" && shop.readAt == null ? { readAt: seen } : {}),
        ...(replied ? { replyNeedsReview: true } : {}),
      });
      return "missed";
    }
    // A form shop's reply arrives by email to the synced mailbox too.
    if (shop.channel === "email" || shop.channel === "form") {
      const mailbox = (await tx.get(db.doc(`subAccounts/${shop.subAccountId}`))).data()?.mailboxConfig;
      const syncedAt = Date.parse(mailbox?.inboxCaughtUpAt ?? "");
      if (mailbox?.lastError || !(syncedAt >= toMs(shop.sentAt)! + RESPONSE_WINDOW_MS)) {
        if (shop.awaitingSync !== true) tx.update(ref, { awaitingSync: true });
        return "awaiting_sync";
      }
    }
    tx.update(ref, { status: "missed", awaitingSync: false, ...(shop.authFailedReplyAt != null ? { disputed: true } : {}) });
    return "missed";
  });
}

/** For a WhatsApp shop: has its contact's thread an inbound row from the target inside the 24 h window? */
async function inboundFromTarget(shop: FirebaseFirestore.DocumentData | undefined): Promise<boolean> {
  const sentMs = toMs(shop?.sentAt);
  if (shop?.channel !== "whatsapp" || sentMs === null || typeof shop.contactId !== "string") return false;
  const rows = await getAdminDb()
    .collection(`contacts/${shop.contactId}/whatsappMessages`)
    .where("direction", "==", "inbound")
    .where("from", "==", shop.target)
    .get();
  return rows.docs.some((d) => {
    const at = toMs(d.data()?.createdAt);
    return at !== null && at >= sentMs && at <= sentMs + RESPONSE_WINDOW_MS;
  });
}

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

/**
 * A member's confirmation of a missed shop — the only way a miss reaches the
 * public report. Keeps the first confirmation. The confirmation time, or why not.
 * A WhatsApp miss also needs a delivery (or read) receipt, no STOP from the
 * business, and — after an automatic-looking reply or an inbound one the
 * matcher did not take (`replyNeedsReview`) — `reviewedAutoReply`.
 */
export async function confirmMissed(
  shopId: string,
  subAccountId: string,
  uid: string,
  opts: { reviewedAutoReply?: boolean } = {},
): Promise<
  Date | "not_found" | "not_missed" | "send_uncertain" | "opted_out" | "not_delivered" | "review_auto_reply" | "review_reply"
> {
  const db = getAdminDb();
  const ref = db.doc(`mysteryShops/${shopId}`);
  return db.runTransaction(async (tx) => {
    const shop = (await tx.get(ref)).data();
    if (!shop || shop.subAccountId !== subAccountId) return "not_found" as const;
    if (shop.status !== "missed") return "not_missed" as const;
    // An enquiry that may never have been sent cannot be published as a missed lead.
    if (shop.sendUncertain === true) return "send_uncertain" as const;
    if (shop.channel === "whatsapp") {
      // The business answered STOP: that is an answer, not a missed lead.
      if (shop.optOutAt != null) return "opted_out" as const;
      // Never publish a miss for a message WhatsApp never confirmed it delivered (or read).
      if (shop.deliveredAt == null && shop.readAt == null) return "not_delivered" as const;
      // An automatic-looking reply, or an inbound one the matcher did not take, may have
      // been a person: the member reads the thread first.
      if (opts.reviewedAutoReply !== true) {
        if (shop.autoReplyAt != null) return "review_auto_reply" as const;
        if (shop.replyNeedsReview === true) return "review_reply" as const;
      }
    }
    const at = toMs(shop.missedConfirmedAt);
    if (at !== null) return new Date(at);
    const now = new Date();
    tx.update(ref, { missedConfirmedAt: now, missedConfirmedByUid: uid });
    return now;
  });
}
