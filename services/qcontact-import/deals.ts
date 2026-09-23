/**
 * Ensures a contact has an open deal in the configured "Install requests"
 * pipeline, once a case has been upserted as a contact: reads
 * GET /api/v1/deals?contact_id= and creates one via POST /api/v1/deals only
 * when the contact has no deal in that pipeline yet (a deal in a different
 * pipeline does not count). Either way, the deal id is returned so run.ts
 * can record the case → deal mapping used by stage-sync.ts — a case whose
 * deal already existed (e.g. a retry after a prior deal-step failure) still
 * needs that mapping recorded, not just a newly-created one.
 *
 * `value`/`currency` are required by the deals API but meaningless for a
 * fresh install request; ZAR is hardcoded because this service is Velocity
 * Fibre only (see README).
 *
 * `assigned_to_uid` is sent only when QCONTACT_DEAL_OWNER_UID is set — it
 * must be the uid of an active sub-account member, or the create 400s (see
 * README: requires the POST /api/v1/deals change from
 * feat/workflow-task-assignee-deal-stage).
 */
import { dedupedIdempotencyKey } from "./idempotency-key.ts";
import { FETCH_TIMEOUT_MS } from "./fetch-timeout.ts";

export type DealEnv = {
  LEADSTACK_API_URL: string;
  LEADSTACK_API_KEY: string;
  QCONTACT_DEAL_PIPELINE_ID: string;
  QCONTACT_DEAL_STAGE: string;
  QCONTACT_DEAL_OWNER_UID: string | undefined;
};

export type DealResult = { ok: true; dealId: string } | { ok: false; error: string };

export type DealEnsurer = (input: {
  contactId: string;
  caseId: number;
  title: string;
}) => Promise<DealResult>;

const DEAL_CURRENCY = "ZAR";

export function leadstackDealEnsurer(env: DealEnv, fetchImpl: typeof fetch = fetch): DealEnsurer {
  return async ({ contactId, caseId, title }) => {
    const listRes = await fetchImpl(
      `${env.LEADSTACK_API_URL}/api/v1/deals?contact_id=${encodeURIComponent(contactId)}`,
      { headers: { Authorization: `Bearer ${env.LEADSTACK_API_KEY}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!listRes.ok) {
      return { ok: false, error: `HTTP ${listRes.status} listing deals: ${(await listRes.text()).slice(0, 300)}` };
    }
    const list = (await listRes.json()) as { data: { id: string; pipeline_id: string }[] };
    const existing = list.data.find((d) => d.pipeline_id === env.QCONTACT_DEAL_PIPELINE_ID);
    if (existing) {
      return { ok: true, dealId: existing.id };
    }

    const body: Record<string, unknown> = {
      contact_id: contactId,
      pipeline_id: env.QCONTACT_DEAL_PIPELINE_ID,
      stage: env.QCONTACT_DEAL_STAGE,
      title,
      value: 0,
      currency: DEAL_CURRENCY,
    };
    if (env.QCONTACT_DEAL_OWNER_UID) body.assigned_to_uid = env.QCONTACT_DEAL_OWNER_UID;
    const createRes = await fetchImpl(`${env.LEADSTACK_API_URL}/api/v1/deals`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.LEADSTACK_API_KEY}`,
        "Content-Type": "application/json",
        // One case = one deal-create request; a retried run replays, never duplicates. The
        // body-fingerprint suffix means a changed title (contact name / case ref) doesn't get
        // stuck 409ing against a stale cached response.
        "Idempotency-Key": dedupedIdempotencyKey(`qcontact-deal-${caseId}`, body),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!createRes.ok) {
      return { ok: false, error: `HTTP ${createRes.status} creating deal: ${(await createRes.text()).slice(0, 300)}` };
    }
    let data: unknown;
    try {
      data = await createRes.json();
    } catch {
      return { ok: false, error: "deal create 2xx without deal.id" };
    }
    const dealId = (data as { deal?: { id?: unknown } } | null)?.deal?.id;
    if (typeof dealId !== "string" || dealId.length === 0) {
      return { ok: false, error: "deal create 2xx without deal.id" };
    }
    return { ok: true, dealId };
  };
}
