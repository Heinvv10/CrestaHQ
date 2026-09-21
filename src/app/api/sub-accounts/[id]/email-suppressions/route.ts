import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import { isValidEmail } from "@/lib/csv";
import {
  SUPPRESSION_REASONS,
  normalizeEmail,
  suppressionDocPath,
} from "@/lib/comms/email-suppression";
import type { EmailSuppressionDoc, EmailSuppressionReason } from "@/types/email";

/**
 * Sub-account email suppression list (W4 PR1). Admin-only: the list decides
 * who this workspace can email at all. Enforcement lives in `sendEmail`.
 */

type Context = { params: Promise<{ id: string }> };

function serialize(d: EmailSuppressionDoc) {
  const at = d.createdAt as { toDate?: () => Date } | null;
  return {
    email: d.email,
    reason: d.reason,
    note: d.note,
    createdByUid: d.createdByUid,
    createdAt: at?.toDate ? at.toDate().toISOString() : null,
  };
}

export async function GET(request: Request, ctx: Context) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;
  const snap = await getAdminDb().collection(`subAccounts/${id}/emailSuppressions`).get();
  const items = snap.docs
    .map((d) => serialize(d.data() as EmailSuppressionDoc))
    .sort((a, b) => a.email.localeCompare(b.email));
  return NextResponse.json({ items });
}

export async function POST(request: Request, ctx: Context) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;
  let body: { email?: unknown; reason?: unknown; note?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  if (!isValidEmail(email) || email.length > 320) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  const reason = (body.reason ?? "manual") as EmailSuppressionReason;
  if (!SUPPRESSION_REASONS.includes(reason)) {
    return NextResponse.json({ error: "Unknown suppression reason." }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) || null : null;

  const db = getAdminDb();
  const agencyId = (await db.doc(`subAccounts/${id}`).get()).data()?.agencyId as string | undefined;
  if (!agencyId) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const doc: EmailSuppressionDoc = {
    agencyId,
    subAccountId: id,
    createdByUid: access.uid,
    email,
    reason,
    note,
    createdAt: FieldValue.serverTimestamp(),
  };
  await db.doc(suppressionDocPath(id, email)).set(doc);
  return NextResponse.json({ ok: true, email });
}

export async function DELETE(request: Request, ctx: Context) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;
  const email = new URL(request.url).searchParams.get("email") ?? "";
  if (!email.trim()) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }
  await getAdminDb().doc(suppressionDocPath(id, email)).delete();
  return NextResponse.json({ ok: true });
}
