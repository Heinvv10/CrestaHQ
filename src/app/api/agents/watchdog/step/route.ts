import "server-only";

import { NextResponse } from "next/server";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import { runWatchdogSweep } from "@/lib/server/agents-watchdog-service";
import { runStaleDealsSweep } from "@/lib/server/agents-stale-deals-service";

/**
 * Hourly Inbox Follow-up Watchdog sweep (Custom Agents v1 — Labs).
 *
 * QStash-scheduled (see lib/qstash/register-schedules.ts — cron `0 * * * *`,
 * auto-registered on cold start). Signature-verified like every other QStash
 * callback; in middleware PUBLIC_PATHS because security is the signature,
 * not the session cookie.
 *
 * The service runs every enabled watchdog sequentially with per-account
 * guards (labs gate, AI gate, token budget), so one misbehaving account
 * can't take down the sweep — failures land in that account's run doc.
 *
 * The Stale deals monitor runs AFTER the watchdog, inside its own time
 * budget, so it can never delay or time out the watchdog; a stale-deals
 * failure is logged and never fails the watchdog's response.
 */
export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }
  const valid = await verifyQStashSignature(signature, rawBody);
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const { agents, results } = await runWatchdogSweep();
    const staleDeals = await runStaleDealsSweep().catch((err: unknown) => {
      console.error(
        "[agents/stale-deals] sweep failed",
        err instanceof Error ? err.message : String(err),
      );
      return { error: "sweep_failed" as const };
    });
    return NextResponse.json({
      ok: true,
      durationMs: Date.now() - startedAt,
      agents,
      results,
      staleDeals,
    });
  } catch (err) {
    console.error("[agents/watchdog] sweep failed", err);
    return NextResponse.json(
      {
        error: "sweep_failed",
        message: err instanceof Error ? err.message : "unknown",
      },
      { status: 500 },
    );
  }
}
