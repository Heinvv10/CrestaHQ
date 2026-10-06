import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { millis } from "@/lib/server/agent-proposals-encoding";
import { readPipelineStages } from "@/lib/pipelines/server";
import { dealPipelineId } from "@/lib/pipelines/stages";
import { DEAL_TRIGGERS, dealStillMatches } from "@/lib/server/agent-enrolment-replay";

const STATUSES = new Set([
  "pending",
  "executing",
  "executed",
  "failed",
  "rejected",
  "expired",
  "unsettled",
]);

const GROUPS: Record<string, string[]> = {
  open: ["pending", "unsettled"],
  // `executing` rides with recent: an approval being run right now (no actions).
  recent: ["executing", "executed", "failed", "rejected", "expired"],
};

/**
 * The statuses a list route's `?status=` names: one status, `open` (pending +
 * unsettled, the actionable rows the approvals pages and the sidebar badges
 * show) or `recent` (the terminal ones). null for an unknown value.
 */
export function statusFilter(status: string): string[] | null {
  if (Object.hasOwn(GROUPS, status)) return GROUPS[status]!;
  return STATUSES.has(status) ? [status] : null;
}

/** Time fields a proposal row carries, sent to the browser as ISO strings. */
const TIME_FIELDS = ["createdAt", "expiresAt", "claimedAt", "decidedAt"] as const;

/** What the approvals page receives for one row. */
export type ProposalView = Record<string, unknown> & {
  id: string;
  /** Held deal enrolments only: where the deal is NOW, next to the stored preview. */
  live?: {
    deal: {
      exists: boolean;
      stageId: string | null;
      stageLabel: string | null;
      /** The approve route's own verdict (dealStillMatches): would it enrol now? */
      wouldReplay: boolean;
    };
  };
};

/**
 * Shape proposal rows for the approvals page: `pinned` never leaves the
 * server (execute acts on it; the approver reviews `preview` only), times
 * become ISO strings, and a held deal enrolment gains the deal's LIVE stage
 * and whether approving would still enrol — computed by the approve route's
 * own `dealStillMatches`, so the page cannot disagree with the server. All
 * reads; a GET never seeds a pipeline.
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
  const stagesOf = new Map<string, Awaited<ReturnType<typeof readPipelineStages>>>();
  for (const deal of deals.values()) {
    const pid = deal ? dealPipelineId(deal) : null;
    if (pid && !stagesOf.has(pid)) stagesOf.set(pid, await readPipelineStages(subAccountId, pid));
  }
  // The approve route's own checks, all rows at once; gated on the same
  // trigger set replay re-checks, so a non-deal trigger reads as replayable.
  const verdicts = new Map(
    await Promise.all(
      views.filter((v) => dealIdOf(v)).map(async (v) => {
        const args = v.args as { type: string; context: Record<string, unknown> };
        const ok = DEAL_TRIGGERS.has(args.type) ? await dealStillMatches(subAccountId, args.type, args.context) : true;
        return [v.id, ok] as const;
      })
    )
  );
  for (const v of views) {
    const id = dealIdOf(v);
    if (!id) continue;
    const deal = deals.get(id) ?? null;
    const stageId = deal ? ((deal.stageId as string | undefined) ?? null) : null;
    const stages = deal ? stagesOf.get(dealPipelineId(deal)) : null;
    v.live = {
      deal: {
        exists: deal !== null,
        stageId,
        stageLabel: stages && stageId ? (stages.find((s) => s.id === stageId)?.label ?? stageId) : stageId,
        wouldReplay: verdicts.get(v.id) ?? false,
      },
    };
  }
  return views;
}
