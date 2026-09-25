import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { millis } from "@/lib/server/agent-proposals-encoding";
import { loadPipeline } from "@/lib/pipelines/server";
import { dealPipelineId, findStage } from "@/lib/pipelines/stages";

/** Time fields a proposal row carries, sent to the browser as ISO strings. */
const TIME_FIELDS = ["createdAt", "expiresAt", "claimedAt", "decidedAt"] as const;

/** What the approvals page receives for one row. */
export type ProposalView = Record<string, unknown> & {
  id: string;
  /** Held deal enrolments only: where the deal is NOW, next to the stored preview. */
  live?: { deal: { exists: boolean; stageId: string | null; stageLabel: string | null } };
};

/**
 * Shape proposal rows for the approvals page: `pinned` never leaves the
 * server (execute acts on it; the approver reviews `preview` only), times
 * become ISO strings, and a held deal enrolment gains the deal's LIVE stage,
 * so the approver sees if it moved since (approve re-checks it anyway).
 */
export async function toProposalViews(
  subAccountId: string,
  docs: Array<{ id: string; data: () => Record<string, unknown> }>
): Promise<ProposalView[]> {
  const views: ProposalView[] = docs.map((d) => {
    const { pinned: _pinned, ...data } = d.data();
    const view: ProposalView = { id: d.id, ...data };
    for (const f of TIME_FIELDS) {
      const ms = millis(data[f]);
      view[f] = ms === null ? null : new Date(ms).toISOString();
    }
    return view;
  });
  const dealIdOf = (v: ProposalView) => {
    const ctx = (v.args as { context?: { dealId?: unknown } } | undefined)?.context;
    return v.approval === "workflow_enrolment" && typeof ctx?.dealId === "string" ? ctx.dealId : null;
  };
  const dealIds = [...new Set(views.map(dealIdOf).filter((id): id is string => id !== null))];
  if (dealIds.length === 0) return views;
  const db = getAdminDb();
  const snaps = await db.getAll(...dealIds.map((id) => db.doc(`deals/${id}`)));
  const deals = new Map(
    snaps.map((s) => [s.id, s.exists && s.data()?.subAccountId === subAccountId ? s.data()! : null])
  );
  const pipelines = new Map<string, Awaited<ReturnType<typeof loadPipeline>>>();
  for (const deal of deals.values()) {
    const pid = deal ? dealPipelineId(deal) : null;
    if (pid && !pipelines.has(pid)) pipelines.set(pid, await loadPipeline(subAccountId, pid));
  }
  for (const v of views) {
    const id = dealIdOf(v);
    if (!id) continue;
    const deal = deals.get(id) ?? null;
    const stageId = deal ? ((deal.stageId as string | undefined) ?? null) : null;
    const pipeline = deal ? pipelines.get(dealPipelineId(deal)) : null;
    v.live = {
      deal: {
        exists: deal !== null,
        stageId,
        stageLabel: pipeline && stageId ? (findStage(pipeline, stageId)?.label ?? stageId) : stageId,
      },
    };
  }
  return views;
}
