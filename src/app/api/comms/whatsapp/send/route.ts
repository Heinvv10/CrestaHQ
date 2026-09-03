import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  sendWhatsappForSubAccount,
  subAccountWhatsappIsConfigured,
} from "@/lib/comms/twilio";
import { dispatchWhatsappSend } from "@/lib/comms/whatsapp/send-dispatch";
import { WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE } from "@/lib/comms/whatsapp/send-mode";
import { getChannelConfig } from "@/lib/comms/ai/agent";
import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import { UsageQuotaExceededError } from "@/lib/server/usage-meter";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import type { SubAccountDoc } from "@/types";

type Body = { contactId?: string; body?: string };

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

  if (!contact.phone) {
    return NextResponse.json(
      { error: "This contact has no phone number." },
      { status: 400 },
    );
  }
  if (contact.whatsappOptedOut) {
    return NextResponse.json(
      { error: "This contact has opted out of WhatsApp." },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const subAccountSnap = await db
    .doc(`subAccounts/${contact.subAccountId}`)
    .get();
  const subAccount = subAccountSnap.exists
    ? (subAccountSnap.data() as SubAccountDoc)
    : null;

  if (subAccount?.whatsappEnabledByAgency !== true) {
    return NextResponse.json(
      { error: "WhatsApp is disabled for this sub-account by your agency." },
      { status: 403 },
    );
  }
  if (!subAccountWhatsappIsConfigured(subAccount?.twilioConfig)) {
    return NextResponse.json(
      {
        error:
          "WhatsApp isn't configured. Add a WhatsApp sender under Settings → SMS.",
      },
      { status: 503 },
    );
  }

  // The 24-hour window decision, the rail choice and the send all belong to
  // dispatchWhatsappSend now. This route used to re-implement the window check
  // inline; keeping it here as well would let the two drift, which is exactly
  // how a template gets sent into an open window at 5x the price.
  const windowHours =
    (await getChannelConfig(contact.subAccountId, "whatsapp"))?.whatsapp
      ?.sessionWindowHours ?? 24;

  let sid: string;
  let fromNumber = "";
  try {
    const result = await dispatchWhatsappSend({
      subAccountId: contact.subAccountId,
      subAccount,
      contactId,
      to: contact.phone,
      body,
      windowHours,
      // This is the manual free-form composer — it has no template to fall
      // back on, so a closed window is a refusal, exactly as before.
      template: null,
      sendViaTwilio: async () => {
        const r = await sendWhatsappForSubAccount({
          subAccountId: contact.subAccountId,
          subAccount,
          to: contact.phone,
          body,
        });
        fromNumber = r.from;
        return { ok: true, messageId: r.sid };
      },
    });

    if (!result.ok) {
      if (result.error === WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE) {
        return NextResponse.json(
          {
            error: `WhatsApp's ${windowHours}-hour messaging window is closed — the contact hasn't messaged within that time. Re-opening the conversation requires an approved message template.`,
            code: "session_window_closed",
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { error: result.error ?? "Failed to send WhatsApp message" },
        { status: 502 },
      );
    }
    sid = result.messageId ?? "";
  } catch (err) {
    if (err instanceof UsageQuotaExceededError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    const message =
      err instanceof Error ? err.message : "Failed to send WhatsApp message";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const preview = body.length > 80 ? `${body.slice(0, 80)}…` : body;

  try {
    await db
      .collection("contacts")
      .doc(contactId)
      .collection("activities")
      .add({
        type: "whatsapp_sent",
        content: `WhatsApp: ${preview}`,
        createdBy: auth.uid,
        meta: { sid },
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn("[whatsapp/send] activity write failed", err);
  }

  // Chat-thread row. Doc id = MessageSid so retries dedupe naturally. Note
  // `from` carries the `whatsapp:` prefix (Twilio's address form) — the
  // thread UI is read-only on this field so it renders fine.
  try {
    await db
      .collection("contacts")
      .doc(contactId)
      .collection("whatsappMessages")
      .doc(sid)
      .set({
        agencyId: contact.agencyId,
        subAccountId: contact.subAccountId,
        contactId,
        direction: "outbound",
        status: "sent",
        body,
        from: fromNumber,
        to: contact.phone,
        twilioMessageSid: sid,
        sentByUid: auth.uid,
        error: null,
        readAt: null,
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn("[whatsapp/send] message-row write failed", err);
  }

  // Unified-inbox index — mirror this outbound into the conversation doc.
  await upsertConversationForMessage({
    contactId,
    subAccountId: contact.subAccountId,
    agencyId: contact.agencyId,
    contactName: contact.name ?? "",
    contactPhone: contact.phone,
    channel: "whatsapp",
    direction: "outbound",
    body,
    pauseBot: true,
  });

  return NextResponse.json({ ok: true, sid });
}
