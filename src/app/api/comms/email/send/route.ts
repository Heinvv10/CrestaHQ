import { NextResponse } from "next/server";
import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import {
  isValidEmailSendPayload,
  sendConversationEmail,
} from "@/lib/server/conversation-send/email";
import { sendOutcomeResponse } from "@/lib/server/conversation-send/http";

/**
 * Manual email send. Auth + request parsing only — every send-time check and
 * the send itself live in the conversation send service, which the
 * scheduled-message worker shares.
 */
export async function POST(request: Request) {
  const auth = requireUid(request);
  if (auth instanceof NextResponse) return auth;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!isValidEmailSendPayload(payload)) {
    return NextResponse.json(
      { error: "Invalid email message or thread headers." },
      { status: 400 }
    );
  }
  const contactId = payload.contactId.trim();
  const subject = payload.subject.trim();
  const body = payload.body.trim();

  if (!contactId || !subject || !body) {
    return NextResponse.json(
      { error: "contactId, subject, and body are required" },
      { status: 400 }
    );
  }

  const contact = await requireContactAccessible(auth.uid, contactId);
  if (contact instanceof NextResponse) return contact;

  return sendOutcomeResponse(
    await sendConversationEmail({
      contactId,
      contact,
      subject,
      body,
      inReplyTo: payload.inReplyTo,
      references: payload.references,
      actor: auth,
    })
  );
}
