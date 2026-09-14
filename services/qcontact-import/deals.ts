/**
 * Ensures a contact has an open deal in the configured "Install requests"
 * pipeline, once a case has been upserted as a contact: reads
 * GET /api/v1/deals?contact_id= and creates one via POST /api/v1/deals only
 * when the contact has no deal in that pipeline yet (a deal in a different
 * pipeline does not count).
 *
 * `value`/`currency` are required by the deals API but meaningless for a
 * fresh install request; ZAR is hardcoded because this service is Velocity
 * Fibre only (see README).
 *
 * `assigned_to_uid` is NOT sent: POST /api/v1/deals's create parser does not
 * read it — assignment is read-only over the public API (see the comment on
 * `assigned_to_uid` in src/lib/api/serializers/deals.ts). QCONTACT_DEAL_OWNER_UID
 * is documented in the README as a currently-no-op env var for this reason.
 */

export type DealEnv = {
  LEADSTACK_API_URL: string;
  LEADSTACK_API_KEY: string;
  QCONTACT_DEAL_PIPELINE_ID: string;
  QCONTACT_DEAL_STAGE: string;
};

export type DealResult = { ok: true } | { ok: false; error: string };

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
      { headers: { Authorization: `Bearer ${env.LEADSTACK_API_KEY}` } },
    );
    if (!listRes.ok) {
      return { ok: false, error: `HTTP ${listRes.status} listing deals: ${(await listRes.text()).slice(0, 300)}` };
    }
    const list = (await listRes.json()) as { data: { pipeline_id: string }[] };
    if (list.data.some((d) => d.pipeline_id === env.QCONTACT_DEAL_PIPELINE_ID)) {
      return { ok: true };
    }

    const body = {
      contact_id: contactId,
      pipeline_id: env.QCONTACT_DEAL_PIPELINE_ID,
      stage: env.QCONTACT_DEAL_STAGE,
      title,
      value: 0,
      currency: DEAL_CURRENCY,
    };
    const createRes = await fetchImpl(`${env.LEADSTACK_API_URL}/api/v1/deals`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.LEADSTACK_API_KEY}`,
        "Content-Type": "application/json",
        // One case = one deal-create request; a retried run replays, never duplicates.
        "Idempotency-Key": `qcontact-deal-${caseId}`,
      },
      body: JSON.stringify(body),
    });
    if (!createRes.ok) {
      return { ok: false, error: `HTTP ${createRes.status} creating deal: ${(await createRes.text()).slice(0, 300)}` };
    }
    return { ok: true };
  };
}
