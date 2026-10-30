import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { recordBroadcastEngagement } from "@/lib/broadcasts/engagement";
import { isUnsubscribeLink } from "@/lib/broadcasts/email-tracking";
import { normalizeEmail, suppressionDocPath } from "@/lib/comms/email-suppression";
import { getAdminDb } from "@/lib/firebase/admin";
import { isDocId } from "@/lib/server/doc-id";
import type { BroadcastSendDoc, EmailEventLookupDoc } from "@/types/broadcasts";
import type { EmailSuppressionDoc, EmailSuppressionReason } from "@/types/email";

/**
 * Resend delivery events for broadcast emails (upstream 1.0.54
 * lib/comms/email-events.ts, on our rails). The event carries the Resend
 * email id; `emailEvents/{id}`, written by the send step only for a Resend
 * send, says which send row it belongs to. The row must be `sent`, in the
 * lookup's sub-account, and must have recorded this exact Resend id —
 * anything else is ignored. SMTP sends never get a lookup.
 *
 *   - delivered / bounced / complained: first-time stamp + parent total in
 *     one transaction (below); retries are harmless.
 *   - opened / clicked: through `recordBroadcastEngagement`, the same
 *     transactional write as our own pixel and click redirect, so the two
 *     sources merge (see engagement.ts) and the same switches govern both.
 *   - a permanent bounce puts the address on the sub-account's suppression
 *     list (`hard_bounce`) and stamps `contact.emailBouncedAt`; a complaint
 *     suppresses (`complaint`) and opts the contact out of email. The
 *     suppression is ensured last and on EVERY delivery of the event, not
 *     only the first, so a retry after a failed write still lands it.
 *
 * Firestore errors propagate: the webhook answers 5xx and Resend retries.
 * No workflow trigger fires here (I3 adds email.opened / email.clicked).
 */

export const TRACKED_EMAIL_EVENTS = [
  "email.delivered",
  "email.opened",
  "email.clicked",
  "email.bounced",
  "email.complained",
] as const;
export type TrackedEmailEvent = (typeof TRACKED_EMAIL_EVENTS)[number];

export function isTrackedEmailEvent(type: unknown): type is TrackedEmailEvent {
  return typeof type === "string" && (TRACKED_EMAIL_EVENTS as readonly string[]).includes(type);
}

export interface ResendDeliveryEvent {
  type: TrackedEmailEvent;
  /** When Resend saw the event (top level; `data.created_at` is the email's own). */
  created_at?: string;
  data?: {
    email_id?: string;
    click?: { link?: string };
    bounce?: { message?: string; type?: string; subType?: string };
  };
}

/** Resend ids are UUIDs; anything else can't be a doc id we wrote. */
const RESEND_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** How long a sent email stays resolvable for delivery/open/click events. */
const EMAIL_EVENT_LOOKUP_DAYS = 90;

/**
 * Written by the broadcast step after Resend accepted the email and before
 * the row settles `sent`, so an event that arrives fast still finds it.
 * Never throws: the email is already out, and a lost lookup only loses its
 * events.
 */
export async function recordBroadcastEmailLookup(input: {
  emailId: string;
  broadcastId: string;
  contactId: string;
  subAccountId: string;
  agencyId: string;
}): Promise<void> {
  if (!RESEND_ID.test(input.emailId)) return;
  const doc: EmailEventLookupDoc = {
    kind: "broadcast",
    broadcastId: input.broadcastId,
    contactId: input.contactId,
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    sentAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromMillis(Date.now() + EMAIL_EVENT_LOOKUP_DAYS * 24 * 3_600_000),
  };
  try {
    await getAdminDb().collection("emailEvents").doc(input.emailId).set(doc);
  } catch (err) {
    console.warn(
      "[email-events] lookup write failed; this email's events will be ignored",
      input.broadcastId,
      input.contactId,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** The event's own time, never in the future; now when absent or unparseable. */
function eventTime(createdAt: string | undefined): Timestamp {
  const ms = createdAt ? Date.parse(createdAt) : NaN;
  return Number.isFinite(ms) && ms <= Date.now() ? Timestamp.fromMillis(ms) : Timestamp.now();
}

interface Outcome {
  first: boolean;
  send: BroadcastSendDoc | null;
}

export async function handleResendDeliveryEvent(event: ResendDeliveryEvent): Promise<void> {
  const emailId = event.data?.email_id;
  if (!emailId || !RESEND_ID.test(emailId)) return;
  const db = getAdminDb();
  const lookupSnap = await db.collection("emailEvents").doc(emailId).get();
  if (!lookupSnap.exists) return;
  const lookup = lookupSnap.data() as EmailEventLookupDoc;
  if (
    lookup.kind !== "broadcast" ||
    !isDocId(lookup.broadcastId) ||
    !isDocId(lookup.contactId) ||
    !isDocId(lookup.subAccountId)
  ) {
    return;
  }
  const at = eventTime(event.created_at);

  if (event.type === "email.opened" || event.type === "email.clicked") {
    const link = event.type === "email.clicked" ? (event.data?.click?.link ?? "").slice(0, 500) : "";
    // Resend rewrites the unsubscribe link too. Opting out is not engagement.
    if (link && isUnsubscribeLink(link, process.env.NEXT_PUBLIC_APP_URL ?? "")) return;
    await recordBroadcastEngagement({
      broadcastId: lookup.broadcastId,
      contactId: lookup.contactId,
      kind: event.type === "email.opened" ? "opened" : "clicked",
      link,
      provider: { emailId, subAccountId: lookup.subAccountId, at },
    });
    return;
  }

  const type: "email.delivered" | "email.bounced" | "email.complained" = event.type;
  const broadcastRef = db.collection("broadcasts").doc(lookup.broadcastId);
  const sendRef = broadcastRef.collection("sends").doc(lookup.contactId);
  const bounce = event.data?.bounce;
  const bounceReason =
    [bounce?.type, bounce?.subType, bounce?.message].filter(Boolean).join(" · ").slice(0, 300) || "bounced";
  // Only a permanent bounce suppresses: a full mailbox ("Transient") or an
  // ambiguous DSN ("Undetermined") would otherwise block the address for good.
  const hardBounce = type === "email.bounced" && (bounce?.type ?? "").toLowerCase() === "permanent";

  const outcome = await db.runTransaction(async (tx): Promise<Outcome> => {
    const snap = await tx.get(sendRef);
    if (!snap.exists) return { first: false, send: null };
    const send = snap.data() as BroadcastSendDoc;
    if (send.status !== "sent" || send.resendMessageId !== emailId || send.subAccountId !== lookup.subAccountId) {
      return { first: false, send: null };
    }
    // A bounced row is final.
    if (send.bouncedAt) return { first: false, send };
    switch (type) {
      case "email.delivered":
        if (send.deliveredAt) return { first: false, send };
        tx.update(sendRef, { deliveredAt: at });
        tx.update(broadcastRef, { "totals.delivered": FieldValue.increment(1) });
        return { first: true, send };
      case "email.bounced":
        tx.update(sendRef, { bouncedAt: at, bounceReason });
        tx.update(broadcastRef, { "totals.bounced": FieldValue.increment(1) });
        return { first: true, send };
      case "email.complained":
        if (send.complainedAt) return { first: false, send };
        tx.update(sendRef, { complainedAt: at });
        tx.update(broadcastRef, { "totals.complained": FieldValue.increment(1) });
        return { first: true, send };
    }
  });

  const { send } = outcome;
  if (!send) return;
  if (outcome.first && type !== "email.delivered") {
    await contactSideEffects(lookup, send, type, { at, bounceReason, hardBounce });
  }
  // Last, and on a repeat too: if it throws, Resend's retry lands it. A
  // complaint on a row that bounced first still suppresses.
  if (hardBounce) await ensureSuppressed(send, "hard_bounce");
  if (type === "email.complained") await ensureSuppressed(send, "complaint");
}

/** Adds the address to the sub-account's suppression list unless it is already there. */
async function ensureSuppressed(send: BroadcastSendDoc, reason: EmailSuppressionReason): Promise<void> {
  const email = normalizeEmail(send.toEmail ?? "");
  if (!email) return;
  const doc: EmailSuppressionDoc = {
    agencyId: send.agencyId,
    subAccountId: send.subAccountId,
    createdByUid: "resend-webhook",
    email,
    reason,
    note: reason === "hard_bounce" ? "Resend reported a permanent bounce." : "Resend reported a spam complaint.",
    createdAt: FieldValue.serverTimestamp(),
  };
  try {
    await getAdminDb().doc(suppressionDocPath(send.subAccountId, email)).create(doc);
  } catch (err) {
    // ALREADY_EXISTS: on the list already (by hand or by an earlier event); keep that entry.
    if ((err as { code?: unknown }).code !== 6) throw err;
  }
}

/** First occurrence only: the timeline row and the contact flag. Best-effort. */
async function contactSideEffects(
  lookup: EmailEventLookupDoc,
  send: BroadcastSendDoc,
  type: "email.bounced" | "email.complained",
  e: { at: Timestamp; bounceReason: string; hardBounce: boolean },
): Promise<void> {
  const db = getAdminDb();
  const contactRef = db.collection("contacts").doc(lookup.contactId);
  try {
    const [contactSnap, broadcastSnap] = await Promise.all([
      contactRef.get(),
      db.collection("broadcasts").doc(lookup.broadcastId).get(),
    ]);
    const contact = contactSnap.data();
    // A deleted or moved contact gets no orphan activity and no flag.
    if (contact?.subAccountId !== send.subAccountId) return;
    const templateName = (broadcastSnap.data()?.templateName as string | undefined) ?? "broadcast";
    // The flag means "this contact's address bounced": not once they changed it.
    const sameAddress = normalizeEmail(String(contact.email ?? "")) === normalizeEmail(send.toEmail ?? "");
    const patch =
      type === "email.complained"
        ? { emailOptedOut: true }
        : e.hardBounce && sameAddress
          ? { emailBouncedAt: e.at }
          : null;
    if (patch) await contactRef.update(patch);
    await contactRef.collection("activities").add({
      type: type === "email.bounced" ? "email_bounced" : "email_complained",
      content:
        type === "email.complained"
          ? `Marked bulk email as spam: ${templateName}. Contact opted out of email; the address is on the suppression list.`
          : e.hardBounce
            ? `Bulk email bounced (${e.bounceReason}): ${templateName}. The address is on the suppression list until an admin removes it.`
            : `Bulk email bounced (${e.bounceReason}): ${templateName}. Temporary bounce; the address stays sendable.`,
      createdBy: "broadcast",
      meta: {
        broadcastId: lookup.broadcastId,
        ...(type === "email.bounced" ? { bounceReason: e.bounceReason, hardBounce: e.hardBounce } : {}),
      },
      agencyId: send.agencyId,
      subAccountId: send.subAccountId,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.warn(
      `[email-events] ${type} contact update failed`,
      lookup.broadcastId,
      lookup.contactId,
      err instanceof Error ? err.message : String(err),
    );
  }
}
