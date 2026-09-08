import "server-only";
import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { syncMailbox } from "@/lib/server/mailbox-sync";
import { mailboxPublicError } from "@/lib/comms/imap";
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;
  try {
    return NextResponse.json(await syncMailbox(id));
  } catch (e) {
    const safe = mailboxPublicError(e);
    return NextResponse.json({ error: safe.message }, { status: safe.status });
  }
}
