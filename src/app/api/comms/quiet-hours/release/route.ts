import "server-only";

import { NextResponse } from "next/server";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import { QUIET_HOURS_RELEASE_PATH } from "@/lib/comms/quiet-hours-hold";
import { releaseQuietHoursHold } from "@/lib/comms/quiet-hours-release";

/**
 * Quiet-hours release worker — one QStash message per held send, published by
 * `holdForQuietHours` with `{subAccountId, holdId}` and a delay to the end of
 * the quiet window.
 *
 * Public path — the QStash signature is the authentication, bound to THIS
 * route so another route's signed call cannot be replayed here. A malformed
 * body is a 400; a worker error is a 500 so QStash retries, which the
 * worker's transactional claim makes safe (at most one send).
 */

export const dynamic = "force-dynamic";

const ID = /^[A-Za-z0-9_-]{1,200}$/;

export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  const url = appUrl ? `${appUrl}${QUIET_HOURS_RELEASE_PATH}` : null;
  if (!url || !(await verifyQStashSignature(signature, rawBody, url))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: { subAccountId?: unknown; holdId?: unknown };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { subAccountId, holdId } = body;
  if (
    typeof subAccountId !== "string" || !ID.test(subAccountId) ||
    typeof holdId !== "string" || !ID.test(holdId)
  ) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  try {
    return NextResponse.json(await releaseQuietHoursHold(subAccountId, holdId));
  } catch (err) {
    console.error("[quiet-hours/release] run failed", err instanceof Error ? err.name : typeof err);
    return NextResponse.json({ error: "release_failed" }, { status: 500 });
  }
}
