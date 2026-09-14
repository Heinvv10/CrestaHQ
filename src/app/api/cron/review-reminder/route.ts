import "server-only";

import { NextResponse } from "next/server";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import { runReviewReminder } from "@/lib/reviews/reminder-run";

/**
 * Review-request reminder worker (SP5 d2) — one QStash message per scheduled
 * reminder, published by the dispatcher / the previous reminder
 * (`lib/reviews/reminder.ts`) with `{subAccountId, requestId, attempt}`.
 *
 * Public path — the QStash signature is the authentication, bound to THIS
 * route (`${NEXT_PUBLIC_APP_URL}/api/cron/review-reminder`) so another
 * route's signed call cannot be replayed here. A malformed body is a 400
 * (retrying cannot fix it); a worker error is a 500 so QStash retries, which
 * the worker's transactional claim makes safe (one attempt, one message).
 */

export const dynamic = "force-dynamic";

const ID = /^[A-Za-z0-9_-]{1,200}$/;

export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  const url = appUrl ? `${appUrl}/api/cron/review-reminder` : null;
  if (!url || !(await verifyQStashSignature(signature, rawBody, url))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: { subAccountId?: unknown; requestId?: unknown; attempt?: unknown };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { subAccountId, requestId, attempt } = body;
  if (
    typeof subAccountId !== "string" || !ID.test(subAccountId) ||
    typeof requestId !== "string" || !ID.test(requestId) ||
    typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1
  ) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  try {
    return NextResponse.json(await runReviewReminder({ subAccountId, requestId, attempt }));
  } catch (err) {
    console.error("[cron/review-reminder] run failed", err instanceof Error ? err.name : typeof err);
    return NextResponse.json({ error: "reminder_failed" }, { status: 500 });
  }
}
