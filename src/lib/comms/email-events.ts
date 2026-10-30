import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";

import {
  ProviderEventNotReadyError,
  providerRowState,
  recordBroadcastEngagement,
} from "@/lib/broadcasts/engagement";
import type { ClaimedRow } from "@/lib/broadcasts/settle-send";
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
 * send, says which send row it belongs to and the address it went to. The
 * row must be in the lookup's sub-account and carry this exact Resend id;
 * anything else is ignored. A row still `queued` (the step has the lookup
 * written but not the settle) throws `ProviderEventNotReadyError`, so the
 * webhook answers 5xx and Resend retries. SMTP sends never get a lookup.
 *
 *   - delivered / bounced / complained: first-time stamp + parent total in
 *     one transaction (below); retries are harmless.
 *   - opened / clicked: through `recordBroadcastEngagement`, the same
 *     transactional write as our own pixel and click redirect, so the two
 *     sources merge (see engagement.ts) and the same switches govern both.
 *   - a permanent bounce (also one after a transient bounce) puts the SENT
 *     address on the sub-account's suppression list (`hard_bounce`) and
 *     stamps `contact.emailBouncedAt` if the contact still has it. A
 *     complaint suppresses the sent address (`complaint`) and opts the
 *     contact out of email whatever address they have now: the person asked
 *     this workspace to stop. A complaint after a bounce still counts.
 *   - the opt-out and the suppression run on EVERY delivery of the event, not
 *     only the first, and throw on failure, so Resend's retry lands them.
 *     The timeline row and the bounce flag are first-only and best-effort.
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
  /** Signed by Resend, but typed loosely: a wrong shape is ignored, never a 500 loop. */
  data?: {
    email_id?: unknown;
    click?: { link?: unknown };
    bounce?: { message?: unknown; type?: unknown; subType?: unknown };
  };
}

/** Resend ids are UUIDs; anything else can't be a doc id we wrote. */
const RESEND_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** How long a sent email stays resolvable for delivery/open/click events. */
const EMAIL_EVENT_LOOKUP_DAYS = 90;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Called by the broadcast step once Resend accepted the email, before the
 * settle: in one transaction, while the step still holds the claim, it
 * stamps the Resend id on the row and writes the lookup with the address the
 * email actually went to. An event that arrives before the settle then
 * finds a row it can wait for (see ProviderEventNotReadyError). Never
 * throws: the email is already out, and a lost lookup only loses its events.
 */
export async function recordBroadcastEmailLookup(input: {
  row: ClaimedRow;
  emailId: string;
  toEmail: string;
  subAccountId: string;
  agencyId: string;
}): Promise<void> {
  const { row } = input;
  if (!RESEND_ID.test(input.emailId)) return;
  const doc: EmailEventLookupDoc = {
    kind: "broadcast",
    broadcastId: row.broadcastRef.id,
    contactId: row.sendRef.id,
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    toEmail: input.toEmail,
    sentAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromMillis(Date.now() + EMAIL_EVENT_LOOKUP_DAYS * 24 * 3_600_000),
  };
  const db = getAdminDb();
  try {
    await db.runTransaction(async (tx) => {
      const current = (await tx.get(row.sendRef)).data() as BroadcastSendDoc | undefined;
      if (current?.status !== "queued" || current.claimId !== row.claimId) return;
      tx.update(row.sendRef, { resendMessageId: input.emailId });
      tx.set(db.collection("emailEvents").doc(input.emailId), doc);
    });
  } catch (err) {
    console.warn(
      "[email-events] lookup write failed; this email's events will be ignored",
      row.broadcastRef.id,
      row.sendRef.id,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** The event's own time, never in the future; now when absent or unparseable. */
function eventTime(createdAt: unknown): Timestamp {
  const ms = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
  return Number.isFinite(ms) && ms <= Date.now() ? Timestamp.fromMillis(ms) : Timestamp.now();
}

interface Outcome {
  first: boolean;
  send: BroadcastSendDoc | null;
}

export async function handleResendDeliveryEvent(event: ResendDeliveryEvent): Promise<void> {
  const emailId = event.data?.email_id;
  if (typeof emailId !== "string" || !RESEND_ID.test(emailId)) return;
  const db = getAdminDb();
  const lookupSnap = await db.collection("emailEvents").doc(emailId).get();
  if (!lookupSnap.exists) return;
  const lookup = lookupSnap.data() as EmailEventLookupDoc;
  if (
    lookup.kind !== "broadcast" ||
    !isDocId(lookup.broadcastId) ||
    !isDocId(lookup.contactId) ||
    !isDocId(lookup.subAccountId) ||
    !normalizeEmail(str(lookup.toEmail))
  ) {
    return;
  }
  const at = eventTime(event.created_at);

  if (event.type === "email.opened" || event.type === "email.clicked") {
    const link = event.type === "email.clicked" ? str(event.data?.click?.link).slice(0, 500) : "";
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
  const bounceType = str(bounce?.type);
  const bounceReason =
    [bounceType, str(bounce?.subType), str(bounce?.message)].filter(Boolean).join(" · ").slice(0, 300) || "bounced";
  // Only a permanent bounce suppresses: a full mailbox ("Transient") or an
  // ambiguous DSN ("Undetermined") would otherwise block the address for good.
  const hardBounce = type === "email.bounced" && bounceType.toLowerCase() === "permanent";

  const outcome = await db.runTransaction(async (tx): Promise<Outcome> => {
    const snap = await tx.get(sendRef);
    if (!snap.exists) return { first: false, send: null };
    const send = snap.data() as BroadcastSendDoc;
    const state = providerRowState(send, emailId, lookup.subAccountId);
    if (state === "pending") throw new ProviderEventNotReadyError(sendRef.path);
    if (state !== "ready") return { first: false, send: null };
    switch (type) {
      case "email.delivered":
        if (send.deliveredAt || send.bouncedAt) return { first: false, send };
        tx.update(sendRef, { deliveredAt: at });
        tx.update(broadcastRef, { "totals.delivered": FieldValue.increment(1) });
        return { first: true, send };
      case "email.bounced":
        if (send.bouncedAt) {
          // A permanent report after a transient one upgrades the row (no second count).
          if (!hardBounce || send.hardBounce) return { first: false, send };
          tx.update(sendRef, { hardBounce: true, bounceReason });
          return { first: true, send };
        }
        tx.update(sendRef, { bouncedAt: at, bounceReason, hardBounce });
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
  if (!send || type === "email.delivered") return;
  if (outcome.first) await firstOccurrence(lookup, send, type, { at, bounceReason, hardBounce });
  if (type === "email.complained") await optOutContact(lookup, send);
  if (hardBounce) await ensureSuppressed(lookup, send, "hard_bounce");
  if (type === "email.complained") await ensureSuppressed(lookup, send, "complaint");
}

/** Adds the sent address to the sub-account's suppression list unless it is already there. */
async function ensureSuppressed(
  lookup: EmailEventLookupDoc,
  send: BroadcastSendDoc,
  reason: EmailSuppressionReason,
): Promise<void> {
  const email = normalizeEmail(lookup.toEmail);
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

/** The contact the row was sent to, or null once it was deleted or moved to another sub-account. */
async function rowContact(lookup: EmailEventLookupDoc, send: BroadcastSendDoc) {
  const ref = getAdminDb().collection("contacts").doc(lookup.contactId);
  const data = (await ref.get()).data();
  return data?.subAccountId === send.subAccountId ? { ref, data } : null;
}

/** Every delivery of a complaint; throws, so a failure is retried. */
async function optOutContact(lookup: EmailEventLookupDoc, send: BroadcastSendDoc): Promise<void> {
  const contact = await rowContact(lookup, send);
  if (contact && contact.data.emailOptedOut !== true) await contact.ref.update({ emailOptedOut: true });
}

/** First occurrence only: the timeline row, and the bounce flag. Best-effort. */
async function firstOccurrence(
  lookup: EmailEventLookupDoc,
  send: BroadcastSendDoc,
  type: "email.bounced" | "email.complained",
  e: { at: Timestamp; bounceReason: string; hardBounce: boolean },
): Promise<void> {
  try {
    const contact = await rowContact(lookup, send);
    if (!contact) return;
    const broadcastSnap = await getAdminDb().collection("broadcasts").doc(lookup.broadcastId).get();
    const templateName = (broadcastSnap.data()?.templateName as string | undefined) ?? "broadcast";
    // The flag means "this contact's address bounced": not once they changed it.
    const sameAddress = normalizeEmail(str(contact.data.email)) === normalizeEmail(lookup.toEmail);
    if (type === "email.bounced" && e.hardBounce && sameAddress) {
      await contact.ref.update({ emailBouncedAt: e.at });
    }
    await contact.ref.collection("activities").add({
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
