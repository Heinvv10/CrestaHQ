import "server-only";

import { NextResponse } from "next/server";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import { isDocId } from "@/lib/server/doc-id";
import { FORM_JOB_PATH, runFormJob } from "@/lib/prospecting/mystery-shop/form/job";

/**
 * The mystery shop's website-form job (Prospecting PR 5c) — one QStash
 * message per form shop, published by the mystery-shop POST with
 * `{ shopId }` once the shop is reserved `queued` (and by the job itself
 * when the box is busy). Fills and submits the form in headless Chromium
 * (lib/prospecting/mystery-shop/form/job.ts) and sets the shop sent /
 * uncertain / refused / failed.
 *
 * Public path — the QStash signature, bound to THIS route's URL, is the
 * authentication. Idempotent on shopId: only a queued form shop runs, so a
 * duplicate delivery is a 200 no-op. A busy box whose re-queue could not be
 * published answers 503, so QStash delivers this message again.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!appUrl || !(await verifyQStashSignature(signature, rawBody, `${appUrl}${FORM_JOB_PATH}`))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let shopId: unknown;
  try {
    shopId = (JSON.parse(rawBody) as { shopId?: unknown }).shopId;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!isDocId(shopId)) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const outcome = await runFormJob(shopId);
  if (outcome === "requeue_failed") return NextResponse.json({ error: "requeue_failed" }, { status: 503 });
  return NextResponse.json({ ok: true, outcome });
}
