import { NextResponse } from "next/server";
import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import {
  isValidEmailSendPayload,
  sendConversationEmail,
} from "@/lib/server/conversation-send/email";
import { sendOutcomeResponse } from "@/lib/server/conversation-send/http";
import { askOutcomeOf, logInboxReviewAsk } from "@/lib/reviews/review-ask";
import type { ConversationDraft } from "@/types/conversations";
import {
  claimConversationDraft,
  clearConversationDraft,
  peekConversationDraft,
  restoreConversationDraft,
} from "@/lib/server/conversation-draft-claim";
import { providerAttempted } from "@/lib/comms/provider-attempt";

/**
 * Manual email send. Auth + request parsing only — every send-time check and
 * the send itself live in the conversation send service, which the
 * scheduled-message worker shares.
 *
 * Approving an AI email draft names it (`draftId`): the draft is claimed in a
 * transaction first, so a draft replaced by a newer one, or approved twice,
 * is 409 and nothing is sent; it goes out with the subject and thread headers
 * stored on the draft (validated like a client's — a member can write
 * pendingDraft), and is put back if the send is refused or throws before
 * reaching the provider. A manual send clears the draft that was pending when
 * it started, never a newer one.
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

  const draftId = (payload as { draftId?: unknown }).draftId;
  if (draftId !== undefined && (typeof draftId !== "string" || !/^[\w-]{1,100}$/.test(draftId))) {
    return NextResponse.json({ error: "Invalid draftId." }, { status: 400 });
  }

  const contact = await requireContactAccessible(auth.uid, contactId);
  if (contact instanceof NextResponse) return contact;

  let claimed: ConversationDraft | null = null;
  if (draftId !== undefined) {
    claimed = await claimConversationDraft(contactId, draftId);
    if (!claimed || claimed.channel !== "email" || !claimed.emailReply) {
      if (claimed) await restoreConversationDraft(contactId, claimed);
      return NextResponse.json(
        { error: "This draft was already sent or replaced by a newer one. Reload the conversation.", code: "draft_changed" },
        { status: 409 }
      );
    }
  }
  const thread = claimed?.emailReply ?? {
    subject,
    inReplyTo: payload.inReplyTo,
    references: payload.references,
  };
  if (
    claimed &&
    (!isValidEmailSendPayload({ contactId, body, ...thread }) ||
      !String(thread.subject).trim())
  ) {
    await restoreConversationDraft(contactId, claimed);
    return NextResponse.json(
      { error: "This draft's email headers are invalid. Reply from the composer instead.", code: "draft_invalid" },
      { status: 409 }
    );
  }
  const seen = claimed ? null : await peekConversationDraft(contactId);

  let outcome;
  try {
    outcome = await sendConversationEmail({
      contactId,
      contact,
      subject: thread.subject,
      body,
      inReplyTo: thread.inReplyTo,
      references: thread.references,
      actor: auth,
    });
  } catch (err) {
    if (claimed && !providerAttempted(err)) await restoreConversationDraft(contactId, claimed);
    throw err;
  }
  if (outcome.ok) {
    if (seen) await clearConversationDraft(contactId, seen);
  } else if (claimed && !outcome.attempted) {
    await restoreConversationDraft(contactId, claimed);
  }
  await logInboxReviewAsk({ contact, channel: "email", parts: [thread.subject, body], actorUid: auth.uid, outcome: askOutcomeOf(outcome) });
  return sendOutcomeResponse(outcome);
}
