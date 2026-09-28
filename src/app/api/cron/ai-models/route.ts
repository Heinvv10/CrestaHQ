import "server-only";

import { NextResponse } from "next/server";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import { refreshModelCatalog } from "@/lib/comms/ai/model-catalog";

/**
 * Daily refresh of the cached OpenRouter model list, so the reply path never
 * has to fetch it. Scheduled as a job of `/api/cron/daily-housekeeping`; this
 * route runs it by hand.
 *
 * Public path — the QStash signature, bound to THIS route's URL, is the
 * authentication. A failed fetch keeps the last good cache and still answers
 * 200 with `ok: false`: QStash retrying minutes later wouldn't help.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  const url = appUrl ? `${appUrl}/api/cron/ai-models` : null;
  if (!url || !(await verifyQStashSignature(signature, rawBody, url))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const now = Date.now();
  const catalog = await refreshModelCatalog({ force: true, now });
  return NextResponse.json({
    ok: catalog?.fetchedAt === now,
    models: catalog?.models.length ?? 0,
    fetchedAt: catalog?.fetchedAt ?? null,
  });
}
