import { NextResponse } from "next/server";
import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import { sendConversationWhatsapp } from "@/lib/server/conversation-send/whatsapp";
import { sendOutcomeResponse } from "@/lib/server/conversation-send/http";
import { askOutcomeOf, logInboxReviewAsk } from "@/lib/reviews/review-ask";
import {
  deleteStaged,
  mediaRefusal,
  stagingPath,
  stagingRail,
  statStaged,
  type StagedAttachment,
  type StagedObject,
} from "@/lib/comms/whatsapp/staged-upload";
import { stagedMediaBudget } from "@/lib/comms/whatsapp/media-budget";
import { videoTranscodeAvailable } from "@/lib/comms/whatsapp/video-tools";
import { transcodesVideo, type WhatsAppProviderCapabilities } from "@/lib/comms/whatsapp/provider";
import { loadStaged, loadVideo } from "./load-attachment";
import type { Contact } from "@/types/contacts";

type Body = {
  contactId?: string;
  body?: string;
  /**
   * Optional file to send alongside the text. Bridge and Cloud rails — see
   * `dispatchWhatsappSend`, which refuses one on Twilio.
   *
   * The file is one the composer already PUT to Storage through
   * `/api/comms/whatsapp/upload-url`; `stagedId` names it. Its type and size
   * are read from Storage, never from this body, and are checked against the
   * rail here, before its bytes are fetched into memory. `contentType` is
   * accepted and ignored. There is no inline form: a body carrying
   * `dataBase64` is refused.
   */
  attachment?: {
    filename?: string;
    contentType?: string;
    stagedId?: string;
    dataBase64?: unknown;
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

  let staged: { stagedId: string; filename: string } | null = null;
  if (payload.attachment) {
    if (payload.attachment.dataBase64 !== undefined) {
      return NextResponse.json(
        {
          error:
            "Inline attachments are not accepted. Upload the file through /api/comms/whatsapp/upload-url and send its stagedId.",
          code: "media_invalid",
        },
        { status: 400 },
      );
    }
    const filename = payload.attachment.filename?.trim();
    const stagedId = payload.attachment.stagedId;
    if (!filename || typeof stagedId !== "string") {
      return NextResponse.json(
        { error: "attachment requires filename and stagedId." },
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
    staged = { stagedId, filename };
  }

  const contact = await requireContactAccessible(auth.uid, contactId);
  if (contact instanceof NextResponse) return contact;

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

  let releaseBudget: (() => void) | null = null;
  try {
    let attachment: StagedAttachment | null = null;
    if (staged && stagedPath) {
      const host = { videoTranscode: await videoTranscodeAvailable() };
      const checked = await checkStaged(contact, stagedPath, host);
      if (checked instanceof NextResponse) return checked;
      const { obj, caps } = checked;
      // A video this host transcodes goes to a temp file, not memory; what
      // this process then holds is at most the rail's video cap.
      const toDisk = host.videoTranscode && transcodesVideo(caps, obj.contentType);
      // Held from before the read until the rail has the file — the whole
      // time its bytes are in this process. A shrink's decode is reserved
      // separately, from the photo's header (image-shrink.ts).
      releaseBudget = await stagedMediaBudget.acquire(
        toDisk ? Math.min(obj.sizeBytes, caps.maxMediaBytes.video) : obj.sizeBytes,
      );
      if (!releaseBudget) {
        return NextResponse.json(
          {
            error: "Other large files are being sent right now. Try again in a minute.",
            code: "media_busy",
          },
          { status: 503, headers: { "Retry-After": "30" } },
        );
      }
      const loaded = toDisk
        ? await loadVideo(obj, staged.filename, caps)
        : await loadStaged(obj, staged.filename, caps);
      if (loaded instanceof NextResponse) return loaded;
      attachment = loaded;
    }
    const outcome = await sendConversationWhatsapp({
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
    });
    releaseBudget?.();
    releaseBudget = null;
    await logInboxReviewAsk({ contact, channel: "whatsapp", parts: [body], actorUid: auth.uid, outcome: askOutcomeOf(outcome) });
    return sendOutcomeResponse(outcome);
  } finally {
    releaseBudget?.();
    // Sent, refused or failed, the staged object has served its purpose: the
    // thread's copy (if any) was made from it already. A resend attaches the
    // file again.
    if (stagedPath) await deleteStaged(stagedPath);
  }
}

/**
 * The staged object, checked against the rail on Storage's word for its type
 * and size — the client's claim at upload time decided only whether it got a
 * URL. Nothing is read yet.
 */
async function checkStaged(
  contact: Contact,
  path: string,
  host: { videoTranscode: boolean },
): Promise<{ obj: StagedObject; caps: WhatsAppProviderCapabilities } | NextResponse> {
  const obj = await statStaged(path);
  if (!obj) {
    return NextResponse.json(
      { error: "The attachment is no longer available. Attach the file again.", code: "media_invalid" },
      { status: 400 },
    );
  }
  const rail = await stagingRail(contact.subAccountId);
  if (!rail.ok) return NextResponse.json({ error: rail.error }, { status: rail.status });
  const refusal = mediaRefusal(rail.capabilities, obj.contentType, obj.sizeBytes, host);
  if (refusal) return NextResponse.json(refusal, { status: 400 });
  return { obj, caps: rail.capabilities };
}
