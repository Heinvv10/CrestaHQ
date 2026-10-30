import "server-only";

import { NextResponse } from "next/server";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import { refreshModelCatalog } from "@/lib/comms/ai/model-catalog";
import { sweepStaleStaged } from "@/lib/comms/whatsapp/staged-upload";
import { runGbpRetentionSweep } from "@/lib/gbp/sync/sweep";
import { collectHeartbeatStats, sendHeartbeat } from "@/lib/gitpage/heartbeat";
import { expireStalePaystackOrders } from "@/lib/server/paystack-order-expiry";
import { sweepOrphanedImports } from "@/lib/google-calendar/import-state";
import { runApiCleanup } from "../api-cleanup/route";

/**
 * Daily housekeeping dispatcher (`leadstack-daily-housekeeping`, 03:00 UTC,
 * register-schedules.ts). The QStash plan caps a deployment at 10 schedules,
 * so the five daily housekeeping jobs share this ONE schedule instead of
 * holding one each. Their own routes still exist and can be run by hand.
 * The calendar-import orphan sweep never had a schedule or route: it lives
 * here only.
 *
 * Jobs run in sequence (in the order their old schedules fired), each in its
 * OWN try: one throwing never stops the rest. Any failure answers 500 naming
 * the failed jobs, so QStash retries — and a retry reruns every job, all of
 * which are safe to repeat (the gitpage heartbeat just sends again).
 *
 * Public path — the QStash signature, bound to THIS route's URL, is the
 * authentication.
 */

export const dynamic = "force-dynamic";

const JOBS: Array<[string, () => Promise<unknown>]> = [
  [
    "gitpage-heartbeat",
    async () => {
      const result = await sendHeartbeat(await collectHeartbeatStats());
      return { sent: result !== null, agency: result?.gitpageStatus?.agency ?? null };
    },
  ],
  [
    // A failed fetch keeps the last good cache and reports `ok: false` — not a
    // job failure, same as its own route: a retry minutes later wouldn't help.
    "ai-models",
    async () => {
      const now = Date.now();
      const catalog = await refreshModelCatalog({ force: true, now });
      return { ok: catalog?.fetchedAt === now, models: catalog?.models.length ?? 0 };
    },
  ],
  [
    "api-cleanup",
    async () => {
      const body = await runApiCleanup();
      if (!body.ok) {
        throw new Error(`sweep_failed: ${(body.failures ?? []).map((f) => f.collection).join(", ")}`);
      }
      return body;
    },
  ],
  ["gbp-retention", () => runGbpRetentionSweep()],
  // Imported Google events whose workspace, member or opt-in no longer allows
  // them (a cleanup that failed). Never had a schedule of its own.
  ["calendar-import-orphans", async () => ({ removed: await sweepOrphanedImports(Date.now() + 30_000) })],
  ["whatsapp-staging-cleanup", () => sweepStaleStaged()],
  // Closes abandoned Paystack buy-page orders after 24 h; bounded per run.
  ["paystack-order-expiry", () => expireStalePaystackOrders()],
];

export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  const url = appUrl ? `${appUrl}/api/cron/daily-housekeeping` : null;
  if (!url || !(await verifyQStashSignature(signature, rawBody, url))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const results: Record<string, unknown> = {};
  const failed: Array<{ job: string; message: string }> = [];
  for (const [job, run] of JOBS) {
    try {
      results[job] = await run();
    } catch (err) {
      console.error(`[cron/daily-housekeeping] job failed job=${job}`, err);
      failed.push({ job, message: err instanceof Error ? err.message : "unknown" });
    }
  }

  return NextResponse.json(
    { ok: failed.length === 0, ...(failed.length > 0 ? { failed } : {}), results },
    { status: failed.length > 0 ? 500 : 200 },
  );
}
