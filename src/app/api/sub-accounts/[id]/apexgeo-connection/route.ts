import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { APEXGEO_DEFAULT_BASE_URL, probeKey } from "@/lib/prospecting/apexgeo-client";
import { apexgeoSecretPath, normalizeBaseUrl, probeFailureReason } from "@/lib/prospecting/apexgeo-connection";

/**
 * Connect / disconnect the sub-account's own ApexGEO account (Prospecting
 * report sections 5/7/8).
 *
 * PUT    — `{ apiKey, baseUrl? }`. The key is checked against ApexGEO (a
 *          read that spends no credits) before anything is stored; a refused
 *          key is never persisted.
 * DELETE — removes the key.
 *
 * Owner/admin only; every member sees the status on the sub-account doc.
 * Not gated on Prospecting: a key can be set up before the agency turns the
 * module on, and removing one must never wait on a gate. The key goes only
 * into the locked `private/apexgeoConnection` doc and no response carries it.
 */

export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: { apiKey?: unknown; baseUrl?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey || apiKey.length > 500 || /\s/.test(apiKey)) {
    return NextResponse.json({ error: "Paste your ApexGEO API key." }, { status: 400 });
  }
  const baseUrl = normalizeBaseUrl(body.baseUrl);
  if (!baseUrl) {
    return NextResponse.json({ error: "The base URL must be an https:// address." }, { status: 400 });
  }

  const probe = await probeKey({ apiKey, baseUrl });
  if (!probe.ok) {
    console.warn("[apexgeo-connection] key check failed", subAccountId, probe.error.kind, probe.error.status);
    return NextResponse.json(
      { error: probeFailureReason(probe.error, baseUrl) },
      { status: probe.error.kind === "network" ? 502 : 400 },
    );
  }

  const db = getAdminDb();
  const batch = db.batch();
  batch.set(db.doc(apexgeoSecretPath(subAccountId)), { apiKey, baseUrl });
  batch.set(
    db.doc(`subAccounts/${subAccountId}`),
    {
      apexgeoConnected: true,
      apexgeoKeyLast4: apiKey.slice(-4),
      apexgeoBaseUrl: baseUrl === APEXGEO_DEFAULT_BASE_URL ? null : baseUrl,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  await batch.commit();
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const batch = db.batch();
  batch.delete(db.doc(apexgeoSecretPath(subAccountId)));
  batch.set(
    db.doc(`subAccounts/${subAccountId}`),
    {
      apexgeoConnected: false,
      apexgeoKeyLast4: null,
      apexgeoBaseUrl: null,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  await batch.commit();
  return NextResponse.json({ ok: true });
}
