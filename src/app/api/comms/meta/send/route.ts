import "server-only";

import { NextResponse } from "next/server";
import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import {
  sendConversationMeta,
  type MetaChannel,
} from "@/lib/server/conversation-send/meta";
import { sendOutcomeResponse } from "@/lib/server/conversation-send/http";

type Body = { contactId?: string; body?: string; channel?: string };

/**
 * Send a manual reply on the BETA Facebook Messenger / Instagram DM channels.
 *
 * Auth + request parsing only. The guards (agency gate, connected Page / IG
 * scope, the contact's `metaUserId`, Meta's 24-hour window), the Graph send,
 * the outbound `metaMessages` row, the activity and the inbox index all live
 * in the conversation send service, which the scheduled-message worker shares
 * (src/lib/server/conversation-send/meta.ts).
 */
export async function POST(request: Request) {
  const auth = requireUid(request);
  if (auth instanceof NextResponse) return auth;

  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const contactId = payload.contactId?.trim();
  const body = payload.body?.trim();
  const channel: MetaChannel =
    payload.channel === "instagram" ? "instagram" : "messenger";

  if (!contactId || !body) {
    return NextResponse.json(
      { error: "contactId and body are required" },
      { status: 400 },
    );
  }

  const contact = await requireContactAccessible(auth.uid, contactId);
  if (contact instanceof NextResponse) return contact;

  return sendOutcomeResponse(
    await sendConversationMeta({ contactId, contact, body, channel, actor: auth }),
  );
}
