import "server-only";

import { NextResponse } from "next/server";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import { REPORT_ID } from "@/lib/prospecting/reports";
import { settleMissed } from "@/lib/prospecting/mystery-shop/store";

/**
 * The mystery shop's 24 h timer — one QStash message per sent shop, published
 * by `POST /api/sub-accounts/[id]/prospecting/mystery-shop` with `{ shopId }`,
 * 24 h + 30 min after the send (the grace lets the 15-minute IMAP sync bring
 * in a reply from the last minutes first).
 *
 * Public path — the QStash signature, bound to THIS route's URL, is the
 * authentication. Idempotent on shopId: a `sent` shop with no response
 * becomes `missed` in a transaction; a responded, missed, failed or unknown
 * shop is a 200 no-op, so a retry or duplicate delivery changes nothing. If
 * this never arrives, the contact's GET settles the shop instead.
 */

export const dynamic = "force-dynamic";

const PATH = "/api/automations/prospecting/mystery-shop";

export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!appUrl || !(await verifyQStashSignature(signature, rawBody, `${appUrl}${PATH}`))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let shopId: unknown;
  try {
    shopId = (JSON.parse(rawBody) as { shopId?: unknown }).shopId;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof shopId !== "string" || !REPORT_ID.test(shopId)) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const status = await settleMissed(shopId);
  return NextResponse.json({ ok: true, status });
}
