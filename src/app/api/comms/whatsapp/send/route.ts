import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  sendWhatsappForSubAccount,
} from "@/lib/comms/twilio";
import { checkWhatsappReadiness } from "@/lib/comms/whatsapp/readiness";
import { dispatchWhatsappSend } from "@/lib/comms/whatsapp/send-dispatch";
import type { BridgeAttachment } from "@/lib/comms/whatsapp/bridge-client";
import { WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE } from "@/lib/comms/whatsapp/send-mode";
import { getChannelConfig } from "@/lib/comms/ai/agent";
import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import { UsageQuotaExceededError } from "@/lib/server/usage-meter";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import type { SubAccountDoc } from "@/types";
import {
  WA_REFUSAL_MESSAGES,
  WA_REFUSAL_STATUS,
} from "@/lib/comms/whatsapp/refusals";

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
  // Readiness is per-rail. Checking Twilio's credentials for a workspace that
  // runs on Meta Cloud is not a stricter check, it is the wrong one — it
  // refuses a correctly configured Cloud workspace and would wave through one
  // whose Cloud credentials are missing.
  const readiness = await checkWhatsappReadiness({
    subAccountId: contact.subAccountId,
    subAccount,
  });
  if (!readiness.ready) {
    return NextResponse.json({ error: readiness.error }, { status: 503 });
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
      // This route is the ONLY human-typed send path: requireUid above means a
      // person with a session pressed send in a thread. Every automated sender
      // — AI auto-reply, review requests, workflow steps — goes through
      // sendWhatsappFreeFormForSubAccount or the workflow engine instead and
      // is left unmarked, so it keeps the full quiet-hours guard.
      humanReply: true,
      attachment,
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
      // A rejected attachment is the request being wrong — too big, wrong
      // type, malformed — and the operator can fix it and send again. Letting
      // it fall through to the 502 below would report a caller error as an
      // infrastructure fault, which is the exact confusion the comment on the
      // rail-refusal branch below condemns.
      // providerOutcome is required as well as the code. "Your request was
      // wrong, fix it and send again" is only safe advice when the provider is
      // certain nothing was delivered — the bridge emits these codes on 4xx
      // today, but an AMBIGUOUS result carrying one would turn this branch
      // into an invitation to double-message a real person, which is the one
      // outcome every rail in this stack exists to prevent.
      if (
        result.providerErrorCode &&
        result.providerOutcome === "DEFINITELY_REJECTED"
      ) {
        return NextResponse.json(
          {
            // Generic: these codes cover the message body (`text_too_long`)
            // as well as the file, and telling an operator their attachment
            // was rejected when they sent no attachment is worse than saying
            // nothing specific.
            error: result.error ?? "WhatsApp rejected this message as sent.",
            code: result.providerErrorCode,
          },
          { status: 400 },
        );
      }
      // A rail deliberately refusing is not a bad gateway. 502 was both untrue
      // — nothing failed — and actively harmful: it sends whoever reads it
      // hunting an infrastructure fault, and it invites proxies and retry
      // logic to treat the refusal as transient and try again, which is the
      // one thing these rails exist to prevent.
      const refusal = result.refusedBy
        ? WA_REFUSAL_MESSAGES[result.refusedBy]
        : undefined;
      if (result.refusedBy) {
        return NextResponse.json(
          {
            // Falls back to the provider's own words rather than a generic
            // line: an unmapped code is a rail we have not worded yet, and the
            // raw reason still beats "couldn't send".
            error: refusal ?? result.error ?? "WhatsApp refused this message.",
            code: result.refusedBy,
          },
          { status: WA_REFUSAL_STATUS },
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
  // The filename, never the bytes. A thread that shows only the caption is a
  // thread where nobody can tell whether the report actually went — which is
  // the question an operator asks the moment a prospect says they got nothing.
  const attachmentMeta = attachment
    ? { filename: attachment.filename, contentType: attachment.contentType }
    : null;

  try {
    await db
      .collection("contacts")
      .doc(contactId)
      .collection("activities")
      .add({
        type: "whatsapp_sent",
        content: attachmentMeta
          ? `WhatsApp: ${preview} [${attachmentMeta.filename}]`
          : `WhatsApp: ${preview}`,
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
        // Null rather than omitted, so a thread row is the same shape whether
        // or not a file went with it and a reader never has to guess whether
        // an absent field means "no attachment" or "written by older code".
        attachment: attachmentMeta,
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
