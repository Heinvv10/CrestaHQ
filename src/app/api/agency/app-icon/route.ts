import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireAgencyOwner } from "@/lib/auth/require-agency-owner";
import { getFirstAgencyId, validateIconPng } from "@/lib/pwa/icons-server";
import { ICON_VARIANTS } from "@/lib/pwa/icon-variants";

/**
 * Custom PWA app icon — agency-owner-only upload/remove.
 *
 * The browser renders the four variants client-side (canvas — see
 * lib/pwa/render-icons-client.ts) and POSTs them as base64 PNG. The server
 * re-validates each one (real PNG, exact dimensions, byte cap) and stores
 * them at agencies/{id}/pwaIcons/{variant}, stamping
 * `agency.pwaIconsUpdatedAt` — the flag the manifest + serving route use.
 * DELETE reverts to the static LeadStack-mark files in /public.
 */

export async function POST(request: Request) {
  const owner = await requireAgencyOwner(request);
  if (owner instanceof NextResponse) return owner;

  const agencyId = await getFirstAgencyId();
  if (!agencyId) {
    return NextResponse.json(
      { error: "No agency exists yet — complete first signup first." },
      { status: 409 },
    );
  }

  let body: { icons?: Record<string, unknown> };
  try {
    body = (await request.json()) as { icons?: Record<string, unknown> };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validated: { key: string; buf: Buffer }[] = [];
  for (const variant of ICON_VARIANTS) {
    const result = validateIconPng(variant.key, body.icons?.[variant.key]);
    if (typeof result === "string") {
      return NextResponse.json(
        { error: `${variant.key}: ${result}` },
        { status: 400 },
      );
    }
    validated.push({ key: variant.key, buf: result });
  }

  const db = getAdminDb();
  const batch = db.batch();
  for (const { key, buf } of validated) {
    batch.set(db.doc(`agencies/${agencyId}/pwaIcons/${key}`), {
      agencyId,
      png: buf.toString("base64"),
      bytes: buf.length,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  batch.update(db.doc(`agencies/${agencyId}`), {
    pwaIconsUpdatedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const owner = await requireAgencyOwner(request);
  if (owner instanceof NextResponse) return owner;

  const agencyId = await getFirstAgencyId();
  if (!agencyId) {
    return NextResponse.json({ ok: true });
  }

  const db = getAdminDb();
  const batch = db.batch();
  for (const variant of ICON_VARIANTS) {
    batch.delete(db.doc(`agencies/${agencyId}/pwaIcons/${variant.key}`));
  }
  batch.update(db.doc(`agencies/${agencyId}`), {
    pwaIconsUpdatedAt: FieldValue.delete(),
  });
  await batch.commit();

  return NextResponse.json({ ok: true });
}
