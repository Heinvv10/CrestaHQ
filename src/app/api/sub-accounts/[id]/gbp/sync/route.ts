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
import { syncSubAccount } from "@/lib/gbp/sync/sub-account";
import { afterSyncResponse } from "@/lib/reputation/after-sync";
import { requestDeadline } from "@/lib/reputation/sentiment-after";
import type { SubAccountDoc } from "@/types";

/**
 * "Sync now" — POST /api/sub-accounts/[id]/gbp/sync
 *
 * Sub-account admin only, agency-gated, at most once a minute per
 * sub-account (409 `too_soon`). Runs the SAME core the scheduled cron runs
 * (`syncSubAccount` — every listing), inline, as a `manual` run by this
 * admin, and answers with the main listing's run as `run` and every
 * listing's as `runs`, public subset only — a skip or a failure is a result,
 * not an HTTP error. A sync that throws is recorded as a failed run and still answered
 * as JSON.
 */

export const dynamic = "force-dynamic";
/** Auto-reply + sentiment run after the response inside this invocation (budget 240 s). */
export const maxDuration = 300;

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const deadline = requestDeadline();
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
    const { runs, synced } = await syncSubAccount(id, { trigger: "manual", actorUid: access.uid });
    // Auto-reply, then sentiment for what this sync changed, after the response — once per sub-account.
    afterSyncResponse([synced], deadline);
    return NextResponse.json({ run: publicRun(runs[0]), runs: runs.map(publicRun) });
  } catch (err) {
    console.error(`[gbp/sync-now] sync threw sa=${id}: ${err instanceof Error ? err.name : typeof err}`);
    const sub = ((await getAdminDb().doc(`subAccounts/${id}`).get()).data() ?? {}) as SubAccountDoc;
    const run = await recordFailedRun(id, sub, "manual", access.uid, now);
    return NextResponse.json({ run: publicRun(run), runs: [publicRun(run)] });
  }
}
