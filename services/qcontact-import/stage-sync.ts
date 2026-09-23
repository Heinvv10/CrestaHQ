/**
 * Moves a QContact case's LeadStack deal to the pipeline stage matching the
 * case's current status. Takes a `dealId` directly (see run.ts's
 * `deals` map in the state file — case id → deal id, recorded when the
 * deal is created) rather than re-deriving the contact/deal from the case:
 * doing that on every case, every 15 minutes, would fire the same
 * enrolment-gated `POST /api/v1/contacts/upsert` used for creation ~670
 * times a run and blow the 50/hour enrolment fuse on the API key, on top
 * of re-writing QContact's copy of the contact's name/address over any
 * manual edit made in the CRM.
 *
 * A single `PATCH /api/v1/deals/:id` per case that needs to move — no
 * lookup call of any kind first. "Only when the stage actually differs"
 * is decided by run.ts comparing against the stage it last recorded for
 * that case (also in the state file), not by fetching the deal.
 */
import { FETCH_TIMEOUT_MS } from "./fetch-timeout.ts";

/**
 * QContact case status → LeadStack deal stage id. QContact renders
 * "Closed – No response" with an EN DASH (U+2013) on some rows and a plain
 * hyphen on others — `statusToStageId` normalizes that before lookup, so
 * only the hyphen form needs a table entry. An unmapped status is left
 * alone: never guess a stage for a status we don't recognise.
 */
const STATUS_TO_STAGE_ID: Record<string, string> = {
  New: "new",
  Assigned: "assigned",
  Upcoming: "upcoming",
  "Pending Customer": "pending_customer",
  "In Progress": "in_progress",
  Escalated: "escalated",
  "PON Not Live": "pon_not_live",
  Solved: "solved",
  "Solved - No Response": "solved_no_response",
  "Unsolved - No Response": "unsolved_no_response",
  "Closed - No response": "closed_no_response",
};

export function statusToStageId(status: string | null): string | undefined {
  if (!status) return undefined;
  return STATUS_TO_STAGE_ID[status.replace(/–/g, "-")];
}

export type StageSyncEnv = {
  LEADSTACK_API_URL: string;
  LEADSTACK_API_KEY: string;
};

/** `not_found` = the deal (a 404 on PATCH) is gone; run.ts drops it from the map. */
export type StageSyncResult =
  | { ok: true; action: "patched" | "not_found" }
  | { ok: false; error: string };

export type StageSyncer = (input: { dealId: string; stage: string }) => Promise<StageSyncResult>;

export function leadstackStageSyncer(env: StageSyncEnv, fetchImpl: typeof fetch = fetch): StageSyncer {
  return async ({ dealId, stage }) => {
    const res = await fetchImpl(`${env.LEADSTACK_API_URL}/api/v1/deals/${encodeURIComponent(dealId)}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${env.LEADSTACK_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ stage }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 404) return { ok: true, action: "not_found" };
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} patching deal: ${(await res.text()).slice(0, 300)}` };
    }
    return { ok: true, action: "patched" };
  };
}
