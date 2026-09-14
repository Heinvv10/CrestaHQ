import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { googleGateOn } from "@/lib/google/gate";
import { GbpFakeRefusedError, getGbpProviderFor } from "@/lib/gbp/provider/select";
import { gbpRefusal } from "@/lib/gbp/route-support";
import { claimManualSlot } from "@/lib/gbp/sync/lease";
import { publicRun } from "@/lib/gbp/sync/public";
import { recordFailedRun } from "@/lib/gbp/sync/record";
import { syncListing } from "@/lib/gbp/sync/run";
import { classifyAfterResponse } from "@/lib/reputation/sentiment-after";
import type { SubAccountDoc } from "@/types";

/**
 * "Sync now" — POST /api/sub-accounts/[id]/gbp/sync
 *
 * Sub-account admin only, agency-gated, at most once a minute per
 * sub-account (409 `too_soon`). Runs the SAME core the scheduled cron runs
 * (`syncListing`), inline, as a `manual` run by this admin, and answers with
 * the run's public subset — a skip or a failure is a result, not an HTTP
 * error. A sync that throws is recorded as a failed run and still answered
 * as JSON.
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
  // The fence before any write of ours (the cooldown claim included).
  try {
    await getGbpProviderFor(id);
  } catch (err) {
    if (!(err instanceof GbpFakeRefusedError)) throw err;
    return gbpRefusal(503, "not_configured", "Google isn't configured on this deployment.");
  }

  const now = new Date();
  if (!(await claimManualSlot(id, now))) {
    return gbpRefusal(409, "too_soon", "A sync ran less than a minute ago — try again shortly.");
  }

  try {
    const run = await syncListing(id, { trigger: "manual", actorUid: access.uid });
    // Sentiment for what this run changed runs after the response (SP5 b).
    classifyAfterResponse([{ subAccountId: id, created: run.created, updated: run.updated }]);
    return NextResponse.json({ run: publicRun(run) });
  } catch (err) {
    console.error(`[gbp/sync-now] sync threw sa=${id}: ${err instanceof Error ? err.name : typeof err}`);
    const sub = ((await getAdminDb().doc(`subAccounts/${id}`).get()).data() ?? {}) as SubAccountDoc;
    const run = await recordFailedRun(id, sub, "manual", access.uid, now);
    return NextResponse.json({ run: publicRun(run) });
  }
}
