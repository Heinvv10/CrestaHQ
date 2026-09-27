import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { prospectingFirstTouchCap } from "@/lib/prospecting/quota";
import type { QuietHoursHold } from "@/lib/comms/quiet-hours";
import type { SubAccountDoc } from "@/types";

/**
 * The approach guard (Prospecting PR 4, ported from ApexSignal
 * `send_batch.py`): a prospect is approached by ONE campaign, and a
 * sub-account makes at most `prospectingDailyFirstTouchCap` first touches a
 * day.
 *
 * Runs in the workflow engine's `runStep` for the send steps, after the step
 * is claimed and after the channel's opt-out / no-address skip (an opted-out
 * prospect is never stamped or counted), before the executor. Manual
 * composer sends, AI sends and broadcasts are not guarded.
 *
 * The campaign key is the workflow id. The first guarded send stamps
 * `prospecting.approachedAt` + `approachedWorkflowId` and takes one from the
 * day's counter, in ONE transaction, BEFORE the send is dispatched — so two
 * workflows racing for the same prospect cannot both pass, and a crash after
 * the stamp errs toward not messaging. Later sends of the same workflow pass
 * and are not counted; any other workflow is refused.
 *
 * Counter: `subAccounts/{id}/prospectingFirstTouch/{YYYY-MM-DD}`, the day in
 * the sub-account's send-window timezone (Africa/Johannesburg when unset).
 * Server-only (default-deny rules). An infrastructure error throws: the
 * caller fails closed and nothing is sent.
 */

export const APPROACH_REFUSED_LOG = "skipped:approach_guard:already_approached";
export const APPROACH_CAP_LOG = "deferred:approach_cap";

const DEFAULT_TZ = "Africa/Johannesburg";
/** Local hour a step held by the cap is retried, the day after. */
const CAP_RETRY_HOUR = 8;

type ContactData = FirebaseFirestore.DocumentData;

/** A prospect: imported as one, or carrying the `prospecting` map. */
export function isProspect(contact: ContactData): boolean {
  return (
    contact.source === "prospecting" ||
    (typeof contact.prospecting === "object" && contact.prospecting !== null)
  );
}

function guardTimezone(sub: Pick<SubAccountDoc, "sendWindow"> | null): string {
  const tz = sub?.sendWindow?.timezone;
  if (!tz) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

/** Calendar day in `tz`, e.g. "2026-09-27". */
export function localDayKey(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Hold until 08:00 local on the NEXT day — today's counter is full until
 *  midnight, so an earlier 08:00 would only be refused again. Naive on DST,
 *  like lib/time/window. */
export function nextDayHold(now: Date, tz: string): QuietHoursHold {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
  const secsOfDay = (get("hour") % 24) * 3600 + get("minute") * 60 + get("second");
  const retryAfterSec = 24 * 3600 - secsOfDay + CAP_RETRY_HOUR * 3600;
  return {
    retryAfterSec,
    until: new Date(Math.floor(now.getTime() / 1000) * 1000 + retryAfterSec * 1000),
    timezone: tz,
  };
}

export type ApproachVerdict =
  /** Send. `firstTouch` = this send stamped the prospect and was counted. */
  | { kind: "pass"; firstTouch: boolean }
  | { kind: "already_approached"; approachedWorkflowId: string | null }
  | { kind: "daily_cap"; hold: QuietHoursHold };

export interface ApproachInput {
  contactId: string;
  subAccountId: string;
  agencyId: string;
  subAccount: SubAccountDoc | null;
  workflowId: string;
  now?: Date;
}

/** Decide, and on a first touch stamp + count, in one transaction. Throws on
 *  an infrastructure error. */
export async function claimApproach(input: ApproachInput): Promise<ApproachVerdict> {
  const db = getAdminDb();
  const now = input.now ?? new Date();
  const tz = guardTimezone(input.subAccount);
  const contactRef = db.doc(`contacts/${input.contactId}`);
  const counterRef = db.doc(
    `subAccounts/${input.subAccountId}/prospectingFirstTouch/${localDayKey(now, tz)}`,
  );
  const cap = prospectingFirstTouchCap(input.subAccount);
  return db.runTransaction(async (tx): Promise<ApproachVerdict> => {
    const contact = (await tx.get(contactRef)).data();
    if (!contact || !isProspect(contact)) return { kind: "pass", firstTouch: false };
    const p = (contact.prospecting ?? {}) as ContactData;
    if (p.approachedAt) {
      return p.approachedWorkflowId === input.workflowId
        ? { kind: "pass", firstTouch: false }
        : {
            kind: "already_approached",
            approachedWorkflowId: typeof p.approachedWorkflowId === "string" ? p.approachedWorkflowId : null,
          };
    }
    const used = ((await tx.get(counterRef)).data()?.count as number | undefined) ?? 0;
    if (used >= cap) return { kind: "daily_cap", hold: nextDayHold(now, tz) };
    tx.set(
      counterRef,
      {
        count: used + 1,
        agencyId: input.agencyId,
        subAccountId: input.subAccountId,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    tx.update(contactRef, {
      "prospecting.approachedAt": FieldValue.serverTimestamp(),
      "prospecting.approachedWorkflowId": input.workflowId,
    });
    return { kind: "pass", firstTouch: true };
  });
}

/** What `runStep` does instead of the send: end the run, or hold the step. */
export type ApproachRefusal =
  | { result: { kind: "end" }; log: typeof APPROACH_REFUSED_LOG }
  | { result: { kind: "defer"; hold: QuietHoursHold }; log: typeof APPROACH_CAP_LOG };

/**
 * The engine's entry point. Null = go ahead and send. A prospect another
 * workflow approached ends the run, with an `automation_step_skipped` row on
 * the contact (keyed on run + step, so a redelivery writes it once). The
 * daily cap holds the step until 08:00 local the next day.
 */
export async function guardProspectSend(
  input: ApproachInput & { runId: string; nodeId: string },
): Promise<ApproachRefusal | null> {
  const verdict = await claimApproach(input);
  if (verdict.kind === "pass") return null;
  if (verdict.kind === "daily_cap") {
    return { result: { kind: "defer", hold: verdict.hold }, log: APPROACH_CAP_LOG };
  }
  try {
    await getAdminDb()
      .doc(`contacts/${input.contactId}/activities/run_${input.runId}_${input.nodeId}_approach_guard`)
      .set({
        type: "automation_step_skipped",
        content: "Workflow message not sent — this prospect was already approached by another workflow.",
        createdBy: "workflow",
        agencyId: input.agencyId,
        subAccountId: input.subAccountId,
        meta: {
          kind: "approach_guard",
          approachedWorkflowId: verdict.approachedWorkflowId,
          workflowId: input.workflowId,
          runId: input.runId,
        },
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn("[prospecting] approach-guard activity write failed", err);
  }
  return { result: { kind: "end" }, log: APPROACH_REFUSED_LOG };
}
