import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { probeKey } from "@/lib/prospecting/apexgeo-client";
import {
  normalizeBaseUrl,
  probeFailureReason,
  readApexgeoConnection,
} from "@/lib/prospecting/apexgeo-connection";

/**
 * POST — check an ApexGEO key without saving it: `{ apiKey, baseUrl? }`
 * tests the pasted key; an empty body tests the stored one. Lists at most
 * one scan, so no credits are spent. Answers `{ ok, reason }` — never the key.
 */

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: { apiKey?: unknown; baseUrl?: unknown } = {};
  const text = await request.text();
  if (text.trim()) {
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  const pasted = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  let conn;
  if (pasted) {
    const baseUrl = normalizeBaseUrl(body.baseUrl);
    if (!baseUrl) return NextResponse.json({ ok: false, reason: "The base URL must be an https:// address." });
    conn = { apiKey: pasted, baseUrl };
  } else {
    conn = await readApexgeoConnection(subAccountId);
    if (!conn) return NextResponse.json({ ok: false, reason: "No ApexGEO key is saved." });
  }

  const probe = await probeKey(conn);
  if (!probe.ok) {
    console.warn("[apexgeo-connection] key test failed", subAccountId, probe.error.kind, probe.error.status);
    return NextResponse.json({ ok: false, reason: probeFailureReason(probe.error, conn.baseUrl) });
  }
  return NextResponse.json({ ok: true, reason: null });
}
