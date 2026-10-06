import "server-only";

import { NextResponse } from "next/server";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import { isKeyCreated } from "@/lib/ai-suite/capabilities/agency-gates";
import { proposalTarget } from "@/lib/server/agent-approval-checks";
import { statusFilter, toProposalViews, type ProposalView } from "@/lib/server/agent-proposals-view";

/**
 * The agency owner's approvals queue (AGENCY_AGENT_API_PLAN.md D4): every
 * row an agency key of THEIR agency queued — agency-level (`subAccountId:
 * null`) or sub-account-scoped — newest first, for one `?status=` (`open`,
 * `recent` or one status; required, so one index serves every query). Each
 * row gains its target (`targetSubAccountId`, `targetName`) and `keyCreated`:
 * whether the proposing key created that target and nothing real touched it
 * yet (`isKeyCreated`), which bounds "Approve all". A row whose target is
 * not in the owner's agency is left out. Owner only.
 */
export async function GET(request: Request) {
  const caller = await requireAgencyOwnerAny(request);
  if (caller instanceof NextResponse) return caller;
  const agencyId = caller.agencyId!;

  const status = new URL(request.url).searchParams.get("status");
  const statuses = status === null ? null : statusFilter(status);
  if (!statuses) return NextResponse.json({ error: "Unknown status" }, { status: 400 });
  const db = getAdminDb();
  let q = db.collection("agentProposals").where("agencyId", "==", agencyId).where("keyLevel", "==", "agency");
  q = statuses.length > 1 ? q.where("status", "in", statuses) : q.where("status", "==", statuses[0]);
  const snap = await q.orderBy("createdAt", "desc").limit(100).get();

  const byTarget = new Map<string, typeof snap.docs>();
  for (const d of snap.docs) {
    const target = proposalTarget(d.data());
    if (target) byTarget.set(target, [...(byTarget.get(target) ?? []), d]);
  }
  const subs = byTarget.size
    ? await db.getAll(...[...byTarget.keys()].map((id) => db.doc(`subAccounts/${id}`)))
    : [];
  const views = new Map<string, ProposalView>();
  for (const sub of subs) {
    const data = sub.data();
    if (data?.agencyId !== agencyId) continue;
    const created = new Map<string, boolean>();
    for (const view of await toProposalViews(sub.id, byTarget.get(sub.id)!)) {
      const keyId = view.keyId as string | undefined;
      if (!created.has(String(keyId))) created.set(String(keyId), await isKeyCreated(sub.id, data, keyId));
      views.set(view.id, {
        ...view,
        targetSubAccountId: sub.id,
        targetName: String(data.name ?? sub.id),
        keyCreated: created.get(String(keyId))!,
      });
    }
  }
  return NextResponse.json({
    proposals: snap.docs.map((d) => views.get(d.id)).filter((v): v is ProposalView => v !== undefined),
  });
}
