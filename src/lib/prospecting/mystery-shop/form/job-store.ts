import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { toMs } from "../model";
import { markUncertain, releaseShop } from "../store";

/**
 * Firestore state of the form job (job.ts): the per-box lease, and the stamps
 * on a queued form shop that say how far a run got. A shop stays `queued`
 * while its job waits and runs; `formStartedAt` = a run claimed it,
 * `formSubmitAt` = the submit click was about to happen. After a crash those
 * stamps decide: submitted (or maybe) = an uncertain send, never refunded;
 * not submitted = failed, refunded. Each is a transaction.
 */

export const LEASE_PATH = "system/mysteryShopFormLease";
const LEASE_MS = 90_000;
/** Re-queues while the box is busy, 120 s apart, before the shop fails `engine_busy`. */
export const MAX_FORM_REQUEUES = 10;
/** A queued form shop this old is stuck: past every re-queue and run. */
export const FORM_STUCK_MS = 45 * 60_000;
/** A run that claimed the shop this recently may still be going (its limit is 45 s). */
const RUN_GRACE_MS = 5 * 60_000;

/** One form job per box: take the lease unless another holder's is still live. */
export async function takeLease(holder: string, nowMs = Date.now()): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(LEASE_PATH);
  return db.runTransaction(async (tx) => {
    const lease = (await tx.get(ref)).data();
    if (lease && lease.holder !== holder && typeof lease.until === "number" && lease.until > nowMs) return false;
    tx.set(ref, { holder, until: nowMs + LEASE_MS });
    return true;
  });
}

/** Give the lease back — only our own. */
export async function releaseLease(holder: string): Promise<void> {
  const db = getAdminDb();
  const ref = db.doc(LEASE_PATH);
  await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).data()?.holder === holder) tx.delete(ref);
  });
}

/** The box was busy: one more re-queue (its number), or "exhausted" (the shop is then failed + refunded), or "gone". */
export async function countRequeue(shopId: string): Promise<number | "exhausted" | "gone"> {
  const db = getAdminDb();
  const ref = db.doc(`mysteryShops/${shopId}`);
  const n = await db.runTransaction(async (tx) => {
    const shop = (await tx.get(ref)).data();
    if (shop?.status !== "queued") return "gone" as const;
    const next = (typeof shop.formRequeues === "number" ? shop.formRequeues : 0) + 1;
    if (next > MAX_FORM_REQUEUES) return "exhausted" as const;
    tx.update(ref, { formRequeues: next });
    return next;
  });
  if (n !== "exhausted") return n;
  // Nothing was attempted: the slot goes back.
  await releaseShop(shopId, "failed", { code: "engine_busy", reason: "The form engine stayed busy; nothing was submitted." });
  return n;
}

export type Claim = "claimed" | "gone" | "crashed_before_submit" | "crashed_after_submit";

/** Claim a queued form shop for this run. A previous run's stamps mean it died: report how far it got. */
export async function claimRun(shopId: string): Promise<Claim> {
  const db = getAdminDb();
  const ref = db.doc(`mysteryShops/${shopId}`);
  return db.runTransaction(async (tx) => {
    const shop = (await tx.get(ref)).data();
    if (shop?.status !== "queued" || shop.channel !== "form") return "gone";
    if (shop.formSubmitAt != null) return "crashed_after_submit";
    if (shop.formStartedAt != null) return "crashed_before_submit";
    tx.update(ref, { formStartedAt: new Date() });
    return "claimed";
  });
}

/**
 * The site answered the enquiry with a refusal (engine `rejected`): the shop
 * is `failed` / `form_rejected`, but a request DID go out, so the cap slot is
 * kept (unlike releaseShop) and no timer runs. A failed shop is never public.
 */
export async function markRejected(shopId: string, reason: string): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`mysteryShops/${shopId}`);
  return db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).data()?.status !== "queued") return false;
    tx.update(ref, { status: "failed", failure: { code: "form_rejected", reason } });
    return true;
  });
}

/** Just before the click: from here on, a crash or timeout is an uncertain send. */
export async function stampSubmit(shopId: string): Promise<void> {
  await getAdminDb().doc(`mysteryShops/${shopId}`).update({ formSubmitAt: new Date() });
}

/**
 * The GET sweep's form branch: a form shop queued past FORM_STUCK_MS whose
 * run never finished. Submitted (or maybe) → an uncertain send; else, unless
 * a run claimed it moments ago → failed `engine_stuck`, slot back.
 */
export async function sweepStuckFormShop(shopId: string, nowMs = Date.now()): Promise<boolean> {
  const quiet = (shop: FirebaseFirestore.DocumentData, field: string) => {
    const at = toMs(shop[field]);
    return at === null || nowMs - at > RUN_GRACE_MS;
  };
  const uncertain = await markUncertain(shopId, null, {
    olderThanMs: FORM_STUCK_MS,
    onlyIf: (s) => s.formSubmitAt != null && quiet(s, "formSubmitAt"),
  });
  if (uncertain) return true;
  return releaseShop(
    shopId,
    "failed",
    { code: "engine_stuck", reason: "The form job never finished; nothing was submitted." },
    { olderThanMs: FORM_STUCK_MS, onlyIf: (s) => s.formSubmitAt == null && quiet(s, "formStartedAt") },
  );
}
