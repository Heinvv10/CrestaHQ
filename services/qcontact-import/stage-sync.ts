/**
 * Syncs a QContact case's status onto its LeadStack deal's stage, so the
 * pipeline reflects QContact as the source of truth for where an install
 * request stands. Runs over every case in the view, not just newly-seen
 * ones — a case can move through several QContact statuses long after its
 * deal was created (see run.ts).
 *
 * The contact is found the same way an upsert finds it: by phone, via
 * `POST /api/v1/contacts/upsert` (see run.ts's Upserter). That call is
 * idempotency-keyed on the case id + body, so repeating it every run either
 * hits the 24h cache or re-sends identical data — cheap either way.
 *
 * `GET /api/v1/deals?contact_id=` finds the contact's deal in
 * QCONTACT_DEAL_PIPELINE_ID (a deal in a different pipeline doesn't count,
 * same as deals.ts); no deal is a no-op. `PATCH /api/v1/deals/:id` with
 * `{ stage }` moves it, only when the stage actually differs.
 */

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
  QCONTACT_DEAL_PIPELINE_ID: string;
};

export type StageSyncResult =
  | { ok: true; action: "synced" | "unchanged" | "no_deal" | "unknown_status" }
  | { ok: false; error: string };

export type StageSyncer = (input: {
  contactId: string;
  status: string | null;
}) => Promise<StageSyncResult>;

export function leadstackStageSyncer(env: StageSyncEnv, fetchImpl: typeof fetch = fetch): StageSyncer {
  return async ({ contactId, status }) => {
    const stageId = statusToStageId(status);
    if (!stageId) return { ok: true, action: "unknown_status" };

    const listRes = await fetchImpl(
      `${env.LEADSTACK_API_URL}/api/v1/deals?contact_id=${encodeURIComponent(contactId)}`,
      { headers: { Authorization: `Bearer ${env.LEADSTACK_API_KEY}` } },
    );
    if (!listRes.ok) {
      return { ok: false, error: `HTTP ${listRes.status} listing deals: ${(await listRes.text()).slice(0, 300)}` };
    }
    const list = (await listRes.json()) as { data: { id: string; pipeline_id: string; stage: string }[] };
    const deal = list.data.find((d) => d.pipeline_id === env.QCONTACT_DEAL_PIPELINE_ID);
    if (!deal) return { ok: true, action: "no_deal" };
    if (deal.stage === stageId) return { ok: true, action: "unchanged" };

    const patchRes = await fetchImpl(`${env.LEADSTACK_API_URL}/api/v1/deals/${encodeURIComponent(deal.id)}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${env.LEADSTACK_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ stage: stageId }),
    });
    if (!patchRes.ok) {
      return { ok: false, error: `HTTP ${patchRes.status} patching deal: ${(await patchRes.text()).slice(0, 300)}` };
    }
    return { ok: true, action: "synced" };
  };
}
