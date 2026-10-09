import "server-only";

import { randomUUID } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { publishCallback } from "@/lib/automations/qstash";
import type { SubAccountDoc } from "@/types";
import { RESPONSE_WINDOW_MS, TIMER_GRACE_MS } from "../model";
import { attachProviderRef, markSent, markUncertain, releaseShop } from "../store";
import { queueTimer } from "../context";
import { runFormFill, type FormResult, type FormRunInput } from "./engine";
import { claimRun, countRequeue, markRejected, releaseLease, stampSubmit, takeLease } from "./job-store";
import { formIdentity } from "./target";

/**
 * The form shop's QStash job (`POST /api/automations/prospecting/mystery-shop-form`
 * `{ shopId }`), published by the mystery-shop POST once the shop is reserved
 * `queued`. One job runs per box at a time (job-store.ts lease): a busy box
 * re-queues the job 120 s later, at most MAX_FORM_REQUEUES times, then fails
 * the shop `engine_busy` (refunded — nothing was attempted). The lease is
 * always given back.
 *
 * Outcomes: confirmed → `sent` and the 24 h timer; submitted without a
 * confirmation (or timed out after the click) → `sent` + `sendUncertain`,
 * slot kept, timer queued; refused / failed before the click → released
 * with the code, slot back; the site refusing the enquiry (a 2xx saying so)
 * → `failed` / `form_rejected`, slot kept (it went out), never public. Idempotent: only a `queued` form shop runs, and a
 * run that finds an earlier run's stamps settles it from them instead
 * (job-store.ts `claimRun`) — the form is never submitted twice.
 */

export const FORM_JOB_PATH = "/api/automations/prospecting/mystery-shop-form";
export const FORM_REQUEUE_S = 120;
const TIMER_DELAY_S = (RESPONSE_WINDOW_MS + TIMER_GRACE_MS) / 1000;

export type FormJobOutcome =
  | "noop" | "requeued" | "requeue_failed" | "engine_busy" | "sent" | "uncertain" | "refused" | "failed" | "rejected";

/** Queue the job. Null when QStash did not take it. */
export function queueFormJob(shopId: string, delaySeconds: number, deduplicationId: string) {
  return publishCallback({ pathname: FORM_JOB_PATH, body: { shopId }, delaySeconds, deduplicationId });
}

const logged = (what: string, shopId: string) => (err: unknown) => {
  console.error(`[mystery-shop/form] ${what} failed`, shopId, err);
  return null;
};

async function settle(shopId: string, result: FormResult, providerRef: string, phone: string | null): Promise<FormJobOutcome> {
  const ref = getAdminDb().doc(`mysteryShops/${shopId}`);
  await ref.update({ formTrace: result.trace, callbackNumber: phone }).catch(logged("trace write", shopId));
  if (result.kind === "rejected") {
    await markRejected(shopId, result.reason);
    return "rejected";
  }
  if (result.kind === "refused" || result.kind === "failed") {
    await releaseShop(shopId, result.kind, { code: result.code, reason: result.reason });
    return result.kind;
  }
  const recorded =
    result.kind === "sent" ? (await markSent(shopId, providerRef)) !== null : await markUncertain(shopId, providerRef);
  // Already moved by the stuck sweep: keep the trace id on it.
  if (!recorded) await attachProviderRef(shopId, providerRef).catch(logged("provider id write", shopId));
  else await queueTimer(shopId, TIMER_DELAY_S, `mystery_shop_${shopId}`);
  return result.kind;
}

export async function runFormJob(
  shopId: string,
  deps: { run?: (input: FormRunInput) => Promise<FormResult>; fetchImpl?: FormRunInput["fetchImpl"] } = {},
): Promise<FormJobOutcome> {
  const db = getAdminDb();
  const shop = (await db.doc(`mysteryShops/${shopId}`).get()).data();
  if (!shop || shop.channel !== "form" || shop.status !== "queued") return "noop";

  const holder = `${shopId}:${randomUUID()}`;
  if (!(await takeLease(holder))) {
    const n = await countRequeue(shopId);
    if (n === "gone") return "noop";
    if (n === "exhausted") return "engine_busy";
    const queued = await queueFormJob(shopId, FORM_REQUEUE_S, `mystery_shop_form_${shopId}_requeue_${n}_${randomUUID()}`);
    return queued ? "requeued" : "requeue_failed";
  }
  try {
    const claim = await claimRun(shopId);
    if (claim === "gone") return "noop";
    if (claim === "crashed_after_submit") {
      if (await markUncertain(shopId, null)) await queueTimer(shopId, TIMER_DELAY_S, `mystery_shop_${shopId}`);
      return "uncertain";
    }
    if (claim === "crashed_before_submit") {
      await releaseShop(shopId, "failed", { code: "engine_failed", reason: "The form engine stopped before submitting." });
      return "failed";
    }
    const sub = (await db.doc(`subAccounts/${shop.subAccountId}`).get()).data() as SubAccountDoc | undefined;
    const enquiry = (shop.formEnquiry ?? {}) as { subject?: unknown; service?: unknown };
    const identity = sub
      ? formIdentity(sub, {
          subject: typeof enquiry.subject === "string" ? enquiry.subject : "",
          service: typeof enquiry.service === "string" ? enquiry.service : "",
          message: String(shop.enquiryText ?? ""),
        })
      : null;
    if (!identity) {
      await releaseShop(shopId, "refused", { code: "channel_unavailable", reason: "The mailbox address isn't known." });
      return "refused";
    }
    const result = await (deps.run ?? runFormFill)({
      url: String(shop.target),
      identity,
      fetchImpl: deps.fetchImpl,
      onBeforeSubmit: () => stampSubmit(shopId),
    });
    return await settle(shopId, result, `form:${shopId}:${Date.now()}`, identity.phone);
  } finally {
    await releaseLease(holder).catch(logged("lease release", shopId));
  }
}
