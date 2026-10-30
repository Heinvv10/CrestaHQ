import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { normalizePhoneE164 } from "@/lib/contacts/phone";

/**
 * PATCH /api/sub-accounts/[id]/branding
 *
 * Update this sub-account's external-facing branding. Logo URL (paste a
 * public https URL) renders on quote/invoice emails, public /q/[token]
 * pages, and PDFs. whatsappNumber (R2) is the optional WhatsApp CTA number
 * on the public prospect report — the surfaces this client's customers see.
 *
 * Auth: sub-account admin OR agency owner (via requireSubAccountAdmin).
 *
 * Body: { logoUrl?: string | null, whatsappNumber?: string | null }
 *   - null / "" → clear the field
 *   - logoUrl: any other string must start with http(s)://
 *   - whatsappNumber: any other string must parse as a valid E.164 number
 */

const URL_RE = /^https?:\/\/.+/i;

interface PatchBody {
  logoUrl?: string | null;
  whatsappNumber?: string | null;
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};

  if ("logoUrl" in body) {
    if (body.logoUrl === null || body.logoUrl === "") {
      updates.logoUrl = null;
    } else if (typeof body.logoUrl === "string") {
      const trimmed = body.logoUrl.trim();
      if (!URL_RE.test(trimmed)) {
        return NextResponse.json(
          { error: "logoUrl must start with http:// or https://." },
          { status: 400 },
        );
      }
      updates.logoUrl = trimmed.slice(0, 2_000);
    }
  }

  if ("whatsappNumber" in body) {
    if (body.whatsappNumber === null || body.whatsappNumber === "") {
      updates.whatsappNumber = null;
    } else if (typeof body.whatsappNumber !== "string") {
      return NextResponse.json(
        { error: "whatsappNumber must be a string or null." },
        { status: 400 },
      );
    } else {
      const e164 = normalizePhoneE164(body.whatsappNumber);
      if (!e164) {
        return NextResponse.json(
          { error: "whatsappNumber must be a valid E.164 phone number, e.g. +27821234567." },
          { status: 400 },
        );
      }
      updates.whatsappNumber = e164;
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: "No valid fields to update" },
      { status: 400 },
    );
  }

  await getAdminDb()
    .doc(`subAccounts/${subAccountId}`)
    .set(
      {
        ...updates,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

  return NextResponse.json({ ok: true, ...updates });
}
