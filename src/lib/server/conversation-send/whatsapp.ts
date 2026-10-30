import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { sendWhatsappForSubAccount } from "@/lib/comms/twilio";
import { checkWhatsappReadiness } from "@/lib/comms/whatsapp/readiness";
import { dispatchWhatsappSend } from "@/lib/comms/whatsapp/send-dispatch";
import { putWhatsappMedia, whatsappMediaPath } from "@/lib/comms/whatsapp/media-storage";
import { copyStagedTo, type StagedAttachment } from "@/lib/comms/whatsapp/staged-upload";
import { mediaKindForMime, mediaPreviewLabel } from "@/types/whatsapp-media";
import { WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE } from "@/lib/comms/whatsapp/send-mode";
import { getChannelConfig } from "@/lib/comms/ai/agent";
import { UsageQuotaExceededError } from "@/lib/server/usage-meter";
import { providerAttempted } from "@/lib/comms/provider-attempt";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import {
  WA_REFUSAL_MESSAGES,
  WA_REFUSAL_STATUS,
} from "@/lib/comms/whatsapp/refusals";
import type { Contact } from "@/types/contacts";
import type { SubAccountDoc } from "@/types";
import {
  refuse,
  type ChannelSendBase,
  type Prepared,
  type SendOutcome,
  type SendRefusal,
} from "./types";

type WhatsappPrepared = Prepared<{ subAccount: SubAccountDoc; to: string }>;

/**
 * Everything that can refuse a free-form WhatsApp message before the window
 * is read. WhatsApp is dedicated-only (no shared-env fallback).
 *
 * The 24-hour window is deliberately NOT here: it belongs to the send, where
 * dispatchWhatsappSend decides it. A scheduled message is checked against the
 * window when it fires, not when it is booked.
 */
export async function prepareWhatsappSend(
  contact: Contact
): Promise<WhatsappPrepared | SendRefusal> {
  if (!contact.phone) {
    return refuse(400, "This contact has no phone number.");
  }
  if (contact.whatsappOptedOut) {
    return refuse(400, "This contact has opted out of WhatsApp.");
  }

  const subAccountSnap = await getAdminDb()
    .doc(`subAccounts/${contact.subAccountId}`)
    .get();
  const subAccount = subAccountSnap.exists
    ? (subAccountSnap.data() as SubAccountDoc)
    : null;

  if (subAccount?.whatsappEnabledByAgency !== true) {
    return refuse(403, "WhatsApp is disabled for this sub-account by your agency.");
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
    return refuse(503, readiness.error);
  }
  return { ok: true, subAccount, to: contact.phone };
}

export async function sendConversationWhatsapp(
  input: ChannelSendBase & {
    /**
     * A file the composer uploaded to Storage. The thread's copy is made by
     * Storage from that object rather than by uploading the bytes again.
     */
    attachment?: StagedAttachment | null;
    /**
     * True only when a person pressed Send in a thread right now. It relaxes
     * the bridge's quiet-hours guard inside an open session; every other
     * caller — including a scheduled send, whose person is not there when it
     * fires — keeps the full guard.
     */
    humanReply: boolean;
    /** Bridge rail only: a stable key so a redelivered send converges. */
    idempotencyKey?: string;
  }
): Promise<SendOutcome> {
  const { contactId, contact, body, actor } = input;
  const staged = input.attachment ?? null;
  const attachment = staged?.outbound ?? null;
  const prepared = await prepareWhatsappSend(contact);
  if (!prepared.ok) return prepared;
  const { subAccount } = prepared;
  const db = getAdminDb();

  // The 24-hour window decision, the rail choice and the send all belong to
  // dispatchWhatsappSend. Re-implementing the window check here as well would
  // let the two drift, which is exactly how a template gets sent into an open
  // window at 5x the price.
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
      to: prepared.to,
      body,
      windowHours,
      // The free-form composer has no template to fall back on, so a closed
      // window is a refusal — never a silent conversion to a template.
      template: null,
      humanReply: input.humanReply,
      // A person's message (composer, or one they scheduled for a time they
      // chose): never held for quiet hours.
      origin: "manual",
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      attachment,
      sendViaTwilio: async () => {
        const r = await sendWhatsappForSubAccount({
          subAccountId: contact.subAccountId,
          subAccount,
          to: prepared.to,
          body,
        });
        fromNumber = r.from;
        return { ok: true, messageId: r.sid };
      },
    });

    if (!result.ok) {
      // Marks every refusal below whose delivery the provider could not rule
      // out. Invisible in the route's response (sendOutcomeResponse sends only
      // error/code); the scheduled worker reads it.
      const waRefuse = (status: number, error: string, code?: string): SendRefusal => {
        const r: SendRefusal = refuse(status, error, code);
        // A rail refusing on its own rules (quiet hours, caps) is not a failed attempt.
        if (result.attempted && !result.refusedBy) r.attempted = true;
        return result.providerOutcome === "AMBIGUOUS" ? { ...r, outcomeUnknown: true } : r;
      };
      if (result.error === WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE) {
        return waRefuse(
          409,
          `WhatsApp's ${windowHours}-hour messaging window is closed — the contact hasn't messaged within that time. Re-opening the conversation requires an approved message template.`,
          "session_window_closed"
        );
      }
      // A rejected attachment is the request being wrong — too big, wrong
      // type, malformed — and the operator can fix it and send again.
      // providerOutcome is required as well as the code: "fix it and send
      // again" is only safe advice when the provider is certain nothing was
      // delivered. An AMBIGUOUS result carrying one would turn this branch
      // into an invitation to double-message a real person.
      if (result.providerErrorCode && result.providerOutcome === "DEFINITELY_REJECTED") {
        return waRefuse(
          400,
          // Generic: these codes cover the message body (`text_too_long`) as
          // well as the file.
          result.error ?? "WhatsApp rejected this message as sent.",
          result.providerErrorCode
        );
      }
      // A rail deliberately refusing is not a bad gateway: a 502 sends whoever
      // reads it hunting an infrastructure fault and invites retry logic to
      // try again, which is the one thing these rails exist to prevent.
      if (result.refusedBy) {
        const refusal = WA_REFUSAL_MESSAGES[result.refusedBy];
        return waRefuse(
          WA_REFUSAL_STATUS,
          // Falls back to the provider's own words: an unmapped code is a rail
          // we have not worded yet, and the raw reason beats "couldn't send".
          refusal ?? result.error ?? "WhatsApp refused this message.",
          result.refusedBy
        );
      }
      return waRefuse(502, result.error ?? "Failed to send WhatsApp message");
    }
    sid = result.messageId ?? "";
  } catch (err) {
    if (err instanceof UsageQuotaExceededError) {
      return refuse(429, err.message);
    }
    const message = err instanceof Error ? err.message : "Failed to send WhatsApp message";
    const refusal = refuse(502, message);
    return providerAttempted(err) ? { ...refusal, attempted: true } : refusal;
  }

  const preview = body.length > 80 ? `${body.slice(0, 80)}…` : body;
  // What the timeline and the inbox list show for a caption-less file — the
  // same label an inbound one gets. The thread row keeps the empty body.
  const mediaLabel =
    attachment && !body
      ? mediaPreviewLabel({
          kind: mediaKindForMime(attachment.contentType),
          mimeType: attachment.contentType,
          filename: attachment.filename,
          sizeBytes: 0,
          storagePath: "",
        })
      : "";

  // The thread's copy of the file, written only now — after the send — so a
  // file the customer never received cannot appear in the thread as if they
  // had. The row gets `media` pointing at the object, or `mediaDropped` when
  // the copy failed: a thread showing only the caption cannot answer "did the
  // report actually go?", and that is the first question asked.
  let mediaFields: Record<string, unknown> = {};
  if (staged && attachment) {
    const storagePath = whatsappMediaPath({
      agencyId: contact.agencyId,
      subAccountId: contact.subAccountId,
      contactId,
      messageDocId: sid,
    });
    // A shrunk photo is stored as sent; anything else is copied by Storage.
    const stored = staged.rewritten
      ? await putWhatsappMedia({
          path: storagePath,
          bytes: Buffer.from(await attachment.data.arrayBuffer()),
          contentType: attachment.contentType,
        })
      : await copyStagedTo(staged.staged, storagePath);
    mediaFields = stored.ok
      ? {
          media: {
            kind: mediaKindForMime(attachment.contentType),
            mimeType: attachment.contentType,
            filename: attachment.filename,
            sizeBytes: attachment.data.size,
            storagePath,
          },
        }
      : { mediaDropped: "store_failed" };
  }

  try {
    await db
      .collection("contacts")
      .doc(contactId)
      .collection("activities")
      .add({
        type: "whatsapp_sent",
        content: mediaLabel
          ? `WhatsApp: ${mediaLabel}`
          : attachment
            ? `WhatsApp: ${preview} [${attachment.filename}]`
            : `WhatsApp: ${preview}`,
        createdBy: actor.uid,
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
        // `media` / `mediaDropped` only on a row that carried a file — absent,
        // not null, on text rows (see src/types/whatsapp-media.ts).
        ...mediaFields,
        sentByUid: actor.uid,
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
    body: body || mediaLabel,
    pauseBot: true,
  });

  return { ok: true, messageId: sid, response: { ok: true, sid } };
}
