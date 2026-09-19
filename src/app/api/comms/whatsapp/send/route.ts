import { NextResponse } from "next/server";
import type { OutboundAttachment } from "@/lib/comms/whatsapp/provider";
import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import { sendConversationWhatsapp } from "@/lib/server/conversation-send/whatsapp";
import { sendOutcomeResponse } from "@/lib/server/conversation-send/http";
import { askOutcomeOf, logInboxReviewAsk } from "@/lib/reviews/review-ask";
import { checkWhatsappVideoCodecs } from "@/lib/comms/whatsapp/video-codec";
import {
  deleteStaged,
  mediaRefusal,
  readStaged,
  stagingPath,
  stagingRail,
  statStaged,
  type StagedObject,
} from "@/lib/comms/whatsapp/staged-upload";
import type { Contact } from "@/types/contacts";

type Body = {
  contactId?: string;
  body?: string;
  /**
   * Optional file to send alongside the text. Bridge and Cloud rails — see
   * `dispatchWhatsappSend`, which refuses one on Twilio.
   *
   * No size or type check here: each rail owns its limits (`capabilitiesFor`),
   * and a second copy of either in this file would be a second number to keep
   * in step. What this
   * route does check is SHAPE — a half-filled attachment is a caller bug and
   * would otherwise reach the bridge as an unnamed or empty file.
   *
   * Two forms. `stagedId` names a file the composer already PUT to Storage
   * through `/api/comms/whatsapp/upload-url`; its type and size are read from
   * Storage, never from this body, and are checked against the rail HERE —
   * the exception to the rule above, because the bytes must not be fetched
   * into memory before the cap says they may. `dataBase64` is the older
   * inline form, kept for any caller still posting it.
   */
  attachment?: {
    filename?: string;
    contentType?: string;
    dataBase64?: string;
    stagedId?: string;
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
  const body = payload.body?.trim() ?? "";

  // A photo or document may go without a caption, as it can from a phone;
  // the attachment itself is validated below. Only a send carrying neither
  // text nor a file is empty.
  if (!contactId || (!body && !payload.attachment)) {
    return NextResponse.json(
      { error: "contactId and body are required" },
      { status: 400 },
    );
  }

  let attachment: OutboundAttachment | null = null;
  let staged: { stagedId: string; filename: string } | null = null;
  if (payload.attachment?.stagedId !== undefined) {
    const filename = payload.attachment.filename?.trim();
    const stagedId = payload.attachment.stagedId;
    if (!filename || typeof stagedId !== "string" || payload.attachment.dataBase64 !== undefined) {
      return NextResponse.json(
        { error: "A staged attachment requires filename and stagedId, and no dataBase64." },
        { status: 400 },
      );
    }
    if (Buffer.byteLength(filename, "utf8") > 255) {
      return NextResponse.json(
        { error: "attachment filename is longer than 255 bytes.", code: "media_invalid" },
        { status: 400 },
      );
    }
    staged = { stagedId, filename };
  } else if (payload.attachment) {
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
    // Standard base64 or nothing. `Buffer.from` decodes garbage leniently —
    // "data:" becomes three bytes — so a malformed payload would otherwise
    // reach a customer as a corrupt file. The client check is bypassable;
    // this is the one that counts. (Non-empty valid base64 always decodes to
    // at least one byte, and empty is refused above.)
    if (dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) {
      return NextResponse.json(
        { error: "attachment dataBase64 is not valid base64.", code: "media_invalid" },
        { status: 400 },
      );
    }
    // Bounded here, for every rail, before anything is sent — the same 255
    // bytes the bridge already refuses over (send.go). The thread row and the
    // activity store this name verbatim; an unbounded one could exceed
    // Firestore's limits AFTER the customer had the file, and both writes are
    // best-effort, so the thread would show nothing was sent.
    if (Buffer.byteLength(filename, "utf8") > 255) {
      return NextResponse.json(
        { error: "attachment filename is longer than 255 bytes.", code: "media_invalid" },
        { status: 400 },
      );
    }
    const bytes = Buffer.from(dataBase64, "base64");
    const codecs = videoCodecRefusal(contentType, bytes);
    if (codecs) return codecs;
    attachment = { filename, contentType, data: new Blob([bytes]) };
  }

  const contact = await requireContactAccessible(auth.uid, contactId);
  if (contact instanceof NextResponse) return contact;

  let stagedObject: StagedObject | null = null;
  let stagedPath: string | null = null;
  if (staged) {
    // Rebuilt from the authorised contact and the caller's own uid — never
    // taken from the request. See staged-upload.ts for the argument.
    stagedPath = stagingPath({
      agencyId: contact.agencyId,
      subAccountId: contact.subAccountId,
      uid: auth.uid,
      stagedId: staged.stagedId,
    });
    if (!stagedPath) {
      return NextResponse.json(
        { error: "attachment stagedId is not valid.", code: "media_invalid" },
        { status: 400 },
      );
    }
  }

  try {
    if (staged && stagedPath) {
      const loaded = await loadStaged(contact, stagedPath, staged.filename);
      if (loaded instanceof NextResponse) return loaded;
      ({ attachment, stagedObject } = loaded);
    }
    const outcome = await sendConversationWhatsapp({
      contactId,
      contact,
      body,
      attachment,
      stagedObject,
    // This route is the ONLY human-typed send path: requireUid above means a
    // person with a session pressed send in a thread. Every automated sender
    // — AI auto-reply, review requests, workflow steps, scheduled sends —
    // is left unmarked, so it keeps the full quiet-hours guard.
      humanReply: true,
      actor: auth,
    });
    await logInboxReviewAsk({ contact, channel: "whatsapp", parts: [body], actorUid: auth.uid, outcome: askOutcomeOf(outcome) });
    return sendOutcomeResponse(outcome);
  } finally {
    // Sent, refused or failed, the staged object has served its purpose: the
    // thread's copy (if any) was made from it already. A resend attaches the
    // file again.
    if (stagedPath) await deleteStaged(stagedPath);
  }
}

/**
 * An MP4 WhatsApp cannot play is accepted by Meta, gets a wamid, and then
 * fails after the thread row already says "sent" — so the codecs are read
 * here, before either rail uploads anything (see video-codec.ts).
 */
function videoCodecRefusal(contentType: string, bytes: Uint8Array): NextResponse | null {
  if (contentType.split(";")[0]!.trim().toLowerCase() !== "video/mp4") return null;
  const codecs = checkWhatsappVideoCodecs(bytes);
  return codecs.ok
    ? null
    : NextResponse.json({ error: codecs.message, code: codecs.code }, { status: 400 });
}

/**
 * The staged file, checked against the rail on Storage's word for its type
 * and size — the client's claim at upload time decided only whether it got a
 * URL — and read into memory only once it has passed.
 */
async function loadStaged(
  contact: Contact,
  path: string,
  filename: string,
): Promise<{ attachment: OutboundAttachment; stagedObject: StagedObject } | NextResponse> {
  const obj = await statStaged(path);
  if (!obj) {
    return NextResponse.json(
      { error: "The attachment is no longer available. Attach the file again.", code: "media_invalid" },
      { status: 400 },
    );
  }
  const rail = await stagingRail(contact.subAccountId);
  if (!rail.ok) return NextResponse.json({ error: rail.error }, { status: rail.status });
  const refusal = mediaRefusal(rail.capabilities, obj.contentType, obj.sizeBytes);
  if (refusal) return NextResponse.json(refusal, { status: 400 });

  let data: Blob;
  try {
    data = await readStaged(obj);
  } catch (err) {
    console.warn("[whatsapp/send] staged read failed", err instanceof Error ? err.message : typeof err);
    return NextResponse.json(
      { error: "The attachment couldn't be read. Attach the file again.", code: "media_invalid" },
      { status: 400 },
    );
  }
  if (obj.contentType === "video/mp4") {
    const codecs = videoCodecRefusal(obj.contentType, new Uint8Array(await data.arrayBuffer()));
    if (codecs) return codecs;
  }
  return { attachment: { filename, contentType: obj.contentType, data }, stagedObject: obj };
}
