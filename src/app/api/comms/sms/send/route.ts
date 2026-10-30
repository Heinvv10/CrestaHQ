import { NextResponse } from "next/server";
import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import { sendConversationSms } from "@/lib/server/conversation-send/sms";
import { sendOutcomeResponse } from "@/lib/server/conversation-send/http";
import { askOutcomeOf, logInboxReviewAsk } from "@/lib/reviews/review-ask";

type Body = { contactId?: string; body?: string };

/**
 * Send an SMS from a contact profile. Auth + request parsing only — the
 * opt-out gate, mode selection (dedicated vs shared Twilio), the send and its
 * bookkeeping live in the conversation send service, which the
 * scheduled-message worker shares.
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

  if (!contactId || !body) {
    return NextResponse.json(
      { error: "contactId and body are required" },
      { status: 400 },
    );
  }

  const contact = await requireContactAccessible(auth.uid, contactId);
  if (contact instanceof NextResponse) return contact;

  const outcome = await sendConversationSms({ contactId, contact, body, actor: auth });
  await logInboxReviewAsk({ contact, channel: "sms", parts: [body], actorUid: auth.uid, outcome: askOutcomeOf(outcome) });
  return sendOutcomeResponse(outcome);
}
