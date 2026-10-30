import "server-only";
import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  getSmtpConnection,
  sendSmtpEmail,
  smtpPublicError,
  validEmail,
} from "@/lib/comms/smtp";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;
  if (!validEmail(access.email))
    return NextResponse.json(
      {
        error: "Your account needs a valid email address to receive the test.",
      },
      { status: 400 }
    );
  try {
    const connection = await getSmtpConnection(id);
    await sendSmtpEmail(connection, {
      to: access.email,
      subject: "SMTP connection test",
      text: "Your workspace SMTP connection successfully sent this test email.",
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const safe = smtpPublicError(error);
    return NextResponse.json({ error: safe.message }, { status: safe.status });
  }
}
