import "server-only";

import { NextResponse } from "next/server";
import { withWhatsappSettings } from "@/lib/comms/whatsapp/settings/route-support";

/**
 * DELETE /api/sub-accounts/[id]/whatsapp/message-links/[code] — admin only.
 * `code` goes into a Graph URL, so it is shape-checked first: Meta's codes
 * are short alphanumerics, and anything else is refused before it can
 * reach a path segment.
 */

export const dynamic = "force-dynamic";

const CODE_RE = /^[A-Za-z0-9]{1,64}$/;

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; code: string }> },
) {
  const { id, code } = await ctx.params;
  if (!CODE_RE.test(code)) {
    return NextResponse.json({ error: "Invalid message link code." }, { status: 400 });
  }
  return withWhatsappSettings(request, id, "admin", async ({ provider }) => {
    await provider.deleteMessageLink(code);
    return NextResponse.json({ ok: true });
  });
}
