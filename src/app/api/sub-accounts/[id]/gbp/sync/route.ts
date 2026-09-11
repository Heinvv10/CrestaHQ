import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { googleGateOn } from "@/lib/google/gate";
import { gbpRefusal } from "@/lib/gbp/route-support";
import { publicRun } from "@/lib/gbp/sync/public";
import { syncListing } from "@/lib/gbp/sync/run";

/**
 * "Sync now" — POST /api/sub-accounts/[id]/gbp/sync
 *
 * Sub-account admin only, agency-gated. Runs the SAME core the scheduled cron
 * runs (`syncListing`), inline, as a `manual` run by this admin, and answers
 * with the run's public subset — a skip or a failure is a result, not an
 * HTTP error.
 */

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;
  if (!(await googleGateOn(id))) {
    return gbpRefusal(403, "gate_off", "This feature is locked by your agency.");
  }

  const run = await syncListing(id, { trigger: "manual", actorUid: access.uid });
  return NextResponse.json({ run: publicRun(run) });
}
