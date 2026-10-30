import "server-only";

import { NextResponse } from "next/server";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import { runCalendarImport } from "@/lib/google-calendar/import";
import { listImportTargets } from "@/lib/google-calendar/import-state";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Headroom under maxDuration; members not reached go first next tick (least recently attempted). */
const BUDGET_MS = 45_000;
/** One calendar never gets more than this, so one heavy member can't starve the rest. */
const PER_MEMBER_MS = 25_000;
const CONCURRENCY = 3;

/**
 * Google Calendar import sweep. Holds no QStash schedule of its own (the
 * plan caps them): the 15-minute `leadstack-email-sync` tick publishes one
 * message here (api/cron/email-sync). Public path — the QStash signature,
 * bound to THIS route's URL, is the authentication. Exits after one
 * Firestore query when no workspace allows import.
 */
export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  const url = appUrl ? `${appUrl}/api/cron/calendar-import` : null;
  if (!url || !(await verifyQStashSignature(signature, rawBody, url))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const startedAt = Date.now();
  const budgetEnd = startedAt + BUDGET_MS;
  const targets = await listImportTargets();
  let done = 0;
  let failed = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length && Date.now() < budgetEnd - 10_000) {
      const t = targets[cursor++];
      const r = await runCalendarImport(t.subAccountId, t.uid, {
        deadlineMs: Math.min(budgetEnd, Date.now() + PER_MEMBER_MS),
      }).catch((err: unknown) => {
        // A Firestore failure before the Google walk; the next member still runs.
        console.error(
          `[cron/calendar-import] pass failed sa=${t.subAccountId} uid=${t.uid}`,
          err instanceof Error ? err.message : String(err),
        );
        return { ok: false };
      });
      if (r.ok) done++;
      else failed++;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return NextResponse.json({ ok: true, targets: targets.length, done, failed, durationMs: Date.now() - startedAt });
}
