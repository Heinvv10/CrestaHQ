import "server-only";

import { NextResponse } from "next/server";
import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import { sendOutcomeResponse } from "@/lib/server/conversation-send/http";
import { cancelScheduledMessage } from "@/lib/server/scheduled-messages/service";

/**
 * DELETE ?contactId= — take a scheduled message off the thread: a pending one
 * is cancelled (it will not fire); a failed or unconfirmed one is dismissed.
 * Never allowed once it is sending or sent. The doc is kept either way as the
 * record. Answers `{ ok, action: "cancelled" | "dismissed" }`.
 */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; msgId: string }> },
) {
  const auth = requireUid(request);
  if (auth instanceof NextResponse) return auth;
  const { id: subAccountId, msgId } = await ctx.params;
  const contactId = new URL(request.url).searchParams.get("contactId")?.trim() ?? "";
  if (!contactId || contactId.includes("/") || !msgId || msgId.includes("/")) {
    return NextResponse.json({ error: "contactId is required." }, { status: 400 });
  }
  const contact = await requireContactAccessible(auth.uid, contactId);
  if (contact instanceof NextResponse) return contact;
  if (contact.subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  const result = await cancelScheduledMessage({
    contactId,
    subAccountId,
    id: msgId,
    actorUid: auth.uid,
  });
  if (!result.ok) return sendOutcomeResponse(result);
  return NextResponse.json({ ok: true, action: result.action });
}
