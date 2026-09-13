import { NextResponse } from "next/server";
import type { BridgeAttachment } from "@/lib/comms/whatsapp/bridge-client";
import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import { sendConversationWhatsapp } from "@/lib/server/conversation-send/whatsapp";
import { sendOutcomeResponse } from "@/lib/server/conversation-send/http";

type Body = {
  contactId?: string;
  body?: string;
  /**
   * Optional file to send alongside the text. Bridge rail only — see
   * `dispatchWhatsappSend`, which refuses one on Twilio and Cloud.
   *
   * No size or type check here: the bridge owns both limits, and a second copy
   * of either in this file would be a second number to keep in step. What this
   * route does check is SHAPE — a half-filled attachment is a caller bug and
   * would otherwise reach the bridge as an unnamed or empty file.
   */
  attachment?: {
    filename?: string;
    contentType?: string;
    dataBase64?: string;
  } | null;
};

/**
 * Send a manual WhatsApp message from a contact profile.
 *
 * WhatsApp is dedicated-only (no shared-env fallback) — the sub-account must
 * have a configured Twilio WhatsApp sender. Two guards beyond the SMS route:
 *
 *   1. whatsappOptedOut — never message a contact who sent STOP.
 *   2. 24-hour session window — WhatsApp only allows free-form (non-template)
 *      messages within 24h of the contact's last INBOUND message. Outside the
 *      window we 409, because sending a template (the only compliant way to
 *      re-open a conversation) is a v2 feature. The window length is read from
 *      the channel config (`whatsapp.sessionWindowHours`, default 24).
 *
 * This route is auth + request parsing only; both guards, the rail choice and
 * the send live in the conversation send service, which the scheduled-message
 * worker shares (src/lib/server/conversation-send/whatsapp.ts).
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

  let attachment: BridgeAttachment | null = null;
  if (payload.attachment) {
    const filename = payload.attachment.filename?.trim();
    const contentType = payload.attachment.contentType?.trim();
    const dataBase64 = payload.attachment.dataBase64?.trim();
    if (!filename || !contentType || !dataBase64) {
      return NextResponse.json(
        {
          error:
            "attachment requires filename, contentType and dataBase64.",
        },
        { status: 400 },
      );
    }
    attachment = { filename, contentType, dataBase64 };
  }

  const contact = await requireContactAccessible(auth.uid, contactId);
  if (contact instanceof NextResponse) return contact;

  return sendOutcomeResponse(
    await sendConversationWhatsapp({
      contactId,
      contact,
      body,
      attachment,
      // This route is the ONLY human-typed send path: requireUid above means a
      // person with a session pressed send in a thread. Every automated sender
      // — AI auto-reply, review requests, workflow steps, scheduled sends —
      // is left unmarked, so it keeps the full quiet-hours guard.
      humanReply: true,
      actor: auth,
    }),
  );
}
