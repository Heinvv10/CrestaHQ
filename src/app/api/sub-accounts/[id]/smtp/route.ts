import "server-only";
import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  smtpMetadata,
  smtpPublicError,
  validateSmtpInput,
  verifySmtpConnection,
} from "@/lib/comms/smtp";
import type { SmtpConnection, SmtpMeta } from "@/types/email";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, ctx: Context) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;
  try {
    const data = (await getAdminDb().doc(`subAccounts/${id}`).get()).data();
    return NextResponse.json({
      config: data?.smtpConfig
        ? smtpMetadata(data.smtpConfig as SmtpMeta)
        : null,
      provider: data?.emailProvider === "smtp" ? "smtp" : "resend",
      resendReady:
        !!process.env.RESEND_API_KEY?.trim() &&
        !!process.env.EMAIL_FROM?.trim(),
    });
  } catch (error) {
    const safe = smtpPublicError(error);
    return NextResponse.json({ error: safe.message }, { status: safe.status });
  }
}

export async function POST(request: Request, ctx: Context) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const db = getAdminDb();
    const secretRef = db.doc(`subAccounts/${id}/private/smtpConnection`);
    const existing = (await secretRef.get()).data() as
      | SmtpConnection
      | undefined;
    const connection = validateSmtpInput(body, existing);
    await verifySmtpConnection(connection);
    connection.verifiedAt = new Date().toISOString();
    const config = smtpMetadata(connection);
    const batch = db.batch();
    batch.set(secretRef, connection);
    batch.set(
      db.doc(`subAccounts/${id}`),
      {
        smtpConfig: config,
        emailProvider: "smtp",
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await batch.commit();
    return NextResponse.json({ ok: true, config, provider: "smtp" });
  } catch (error) {
    const safe = smtpPublicError(error);
    return NextResponse.json({ error: safe.message }, { status: safe.status });
  }
}

export async function DELETE(request: Request, ctx: Context) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;
  try {
    const db = getAdminDb();
    const batch = db.batch();
    batch.delete(db.doc(`subAccounts/${id}/private/smtpConnection`));
    batch.set(
      db.doc(`subAccounts/${id}`),
      {
        smtpConfig: null,
        emailProvider: "resend",
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await batch.commit();
    return NextResponse.json({ ok: true });
  } catch (error) {
    const safe = smtpPublicError(error);
    return NextResponse.json({ error: safe.message }, { status: safe.status });
  }
}
