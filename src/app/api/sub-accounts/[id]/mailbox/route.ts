import "server-only";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  mailboxMetadata,
  mailboxPublicError,
  validateMailboxInput,
  verifyMailboxConnection,
  MailboxError,
} from "@/lib/comms/imap";
import type { SmtpConnection } from "@/types/email";
import type { MailboxMeta } from "@/types/mailbox";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, ctx: Context) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;
  try {
    const data = (await getAdminDb().doc(`subAccounts/${id}`).get()).data();
    return NextResponse.json({
      config: data?.mailboxConfig
        ? mailboxMetadata(data.mailboxConfig as MailboxMeta)
        : null,
    });
  } catch (e) {
    const safe = mailboxPublicError(e);
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
    const smtp = (
      await db.doc(`subAccounts/${id}/private/smtpConnection`).get()
    ).data() as SmtpConnection | undefined;
    const connection = validateMailboxInput(body, smtp);
    const operation = db.doc(`subAccounts/${id}/private/mailboxOperation`);
    const generation = randomUUID();
    await operation.set({ generation });
    await verifyMailboxConnection(connection);
    const config = mailboxMetadata(connection);
    await db.runTransaction(async (tx) => {
      if ((await tx.get(operation)).data()?.generation !== generation)
        throw new MailboxError(
          "Mailbox settings changed while verifying. Connect again if needed.",
          409
        );
      tx.set(db.doc(`subAccounts/${id}/private/mailboxConnection`), connection);
      tx.update(db.doc(`subAccounts/${id}`), { mailboxConfig: config });
    });
    return NextResponse.json({ config });
  } catch (e) {
    const safe = mailboxPublicError(e);
    return NextResponse.json({ error: safe.message }, { status: safe.status });
  }
}
export async function DELETE(request: Request, ctx: Context) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;
  try {
    const db = getAdminDb(),
      batch = db.batch();
    batch.delete(db.doc(`subAccounts/${id}/private/mailboxConnection`));
    batch.set(db.doc(`subAccounts/${id}/private/mailboxOperation`), {
      generation: randomUUID(),
    });
    batch.update(db.doc(`subAccounts/${id}`), { mailboxConfig: null });
    await batch.commit();
    return NextResponse.json({ ok: true });
  } catch (e) {
    const safe = mailboxPublicError(e);
    return NextResponse.json({ error: safe.message }, { status: safe.status });
  }
}
