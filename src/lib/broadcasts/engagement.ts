import "server-only";

import { FieldValue, type Timestamp } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import type { BroadcastSendDoc, SubAccountDoc } from "@/types";

/**
 * Record one open or click on a broadcast send row — the write behind our
 * own pixel and click redirect. Same fields as upstream's Resend handler
 * (lib/comms/email-events.ts), so the stats page reads one shape whatever
 * measured it:
 *   - first open  → `openedAt`, `totals.opened` +1; every open → `opens` +1
 *   - first click → `clickedAt`, `totals.clicked` +1; every click → `clicks` +1.
 *     A click with no open yet also stamps `openedAt` (the pixel was blocked)
 *     — only while open tracking is on too: opens off means no open is
 *     recorded, by the pixel or by a click.
 * The "first" decision and the totals move in one transaction, so a burst of
 * opens counts the recipient once. Per-row counters stop at
 * ENGAGEMENT_COUNT_CAP — a replayed token can't grow them without bound.
 *
 * Nothing is written unless the row was sent and the sub-account still has
 * that kind of tracking on: switching it off stops collection for emails
 * already out. The step has no persisted "provider accepted" state between
 * the SMTP accept and the settle that marks the row `sent`, so an open or
 * click in that gap (normally under a second), or on a row later failed as
 * "delivery unknown", is not recorded.
 *
 * On the first occurrence only, an `email_opened` / `email_clicked` activity
 * lands on the contact. No workflow trigger fires here (I3 adds those).
 *
 * Resend's own open / click events (lib/comms/email-events.ts) come through
 * here too, with `provider` set. Both sources count: `opens` / `clicks` add
 * up events from either, `totals.*` still count the recipient once, and
 * `openedAt` / `clickedAt` keep the EARLIEST time — a provider event carries
 * the time Resend saw it and replaces a later stamp. The same switches
 * govern both. A provider event only lands on the row that recorded its
 * Resend id, in the lookup's sub-account, and waits (throws) while that row
 * is still queued. A bounced row takes neither.
 */

export const ENGAGEMENT_COUNT_CAP = 100;

/**
 * A provider event for a row the step has not settled yet (the Resend id is
 * stamped, the row still `queued`). The webhook answers 5xx so the provider
 * retries once the row reads `sent`.
 */
export class ProviderEventNotReadyError extends Error {
  constructor(path: string) {
    super(`send row not settled yet: ${path}`);
    this.name = "ProviderEventNotReadyError";
  }
}

/**
 * Whether a provider event for `emailId` may land on `send`: `ready` (sent,
 * with this id, in this sub-account), `pending` (still queued with this id
 * or none yet: retry later), `unconfirmed` (failed as "delivery unknown"
 * after the provider took it: bounce and complaint effects only), or
 * `foreign` (ignore).
 */
export function providerRowState(
  send: BroadcastSendDoc,
  emailId: string,
  subAccountId: string,
): "ready" | "pending" | "unconfirmed" | "foreign" {
  if (send.subAccountId !== subAccountId) return "foreign";
  if (send.status === "queued" && (send.resendMessageId == null || send.resendMessageId === emailId)) {
    return "pending";
  }
  if (send.resendMessageId !== emailId) return "foreign";
  return send.status === "sent" ? "ready" : send.status === "failed" ? "unconfirmed" : "foreign";
}

export type EngagementKind = "opened" | "clicked";

interface Outcome {
  first: boolean;
  send: BroadcastSendDoc | null;
}

export async function recordBroadcastEngagement(input: {
  broadcastId: string;
  contactId: string;
  kind: EngagementKind;
  /** The clicked destination, for the activity row. */
  link?: string;
  /** A Resend event: binds it to its row, and the time it happened. */
  provider?: { emailId: string; subAccountId: string; at: Timestamp };
}): Promise<void> {
  const db = getAdminDb();
  const broadcastRef = db.collection("broadcasts").doc(input.broadcastId);
  const sendRef = broadcastRef.collection("sends").doc(input.contactId);
  const trackingKey = input.kind === "opened" ? "opens" : "clicks";

  const outcome = await db.runTransaction(async (tx): Promise<Outcome> => {
    const snap = await tx.get(sendRef);
    if (!snap.exists) return { first: false, send: null };
    const send = snap.data() as BroadcastSendDoc;
    const provider = input.provider;
    if (provider) {
      const state = providerRowState(send, provider.emailId, provider.subAccountId);
      if (state === "pending") throw new ProviderEventNotReadyError(sendRef.path);
      if (state !== "ready") return { first: false, send: null };
    }
    if (send.status !== "sent" || !send.subAccountId || send.bouncedAt) return { first: false, send: null };
    const sub = (await tx.get(db.collection("subAccounts").doc(send.subAccountId))).data() as
      | SubAccountDoc
      | undefined;
    if (sub?.emailTracking?.[trackingKey] !== true) return { first: false, send: null };

    const at = provider?.at;
    if (input.kind === "opened") {
      const first = !send.openedAt;
      const openedAt = stampFor(send.openedAt, at);
      const room = (send.opens ?? 0) < ENGAGEMENT_COUNT_CAP;
      if (!openedAt && !room) return { first: false, send };
      tx.update(sendRef, {
        ...(openedAt ? { openedAt } : {}),
        ...(room ? { opens: FieldValue.increment(1) } : {}),
      });
      if (first) tx.update(broadcastRef, { "totals.opened": FieldValue.increment(1) });
      return { first, send };
    }

    const first = !send.clickedAt;
    const clickedAt = stampFor(send.clickedAt, at);
    const openedAt = sub.emailTracking?.opens === true ? stampFor(send.openedAt, at) : null;
    const impliedOpen = !send.openedAt && openedAt !== null;
    const room = (send.clicks ?? 0) < ENGAGEMENT_COUNT_CAP;
    if (!clickedAt && !openedAt && !room) return { first: false, send };
    tx.update(sendRef, {
      ...(clickedAt ? { clickedAt } : {}),
      ...(openedAt ? { openedAt } : {}),
      ...(room ? { clicks: FieldValue.increment(1) } : {}),
    });
    const bump: Record<string, FieldValue> = {};
    if (first) bump["totals.clicked"] = FieldValue.increment(1);
    if (impliedOpen) bump["totals.opened"] = FieldValue.increment(1);
    if (Object.keys(bump).length > 0) tx.update(broadcastRef, bump);
    return { first, send };
  });

  if (!outcome.first || !outcome.send) return;
  await writeActivity(db, broadcastRef, outcome.send, input);
}

async function writeActivity(
  db: FirebaseFirestore.Firestore,
  broadcastRef: FirebaseFirestore.DocumentReference,
  send: BroadcastSendDoc,
  input: { contactId: string; kind: EngagementKind; link?: string },
): Promise<void> {
  const contactRef = db.collection("contacts").doc(input.contactId);
  try {
    const [contactSnap, broadcastSnap] = await Promise.all([contactRef.get(), broadcastRef.get()]);
    // A deleted (or moved) contact gets no orphan activity subcollection.
    if (contactSnap.data()?.subAccountId !== send.subAccountId) return;
    const templateName = (broadcastSnap.data()?.templateName as string | undefined) ?? "broadcast";
    const link = linkWithoutQuery(input.link);
    await contactRef.collection("activities").add({
      type: input.kind === "opened" ? "email_opened" : "email_clicked",
      content:
        input.kind === "opened"
          ? `Opened bulk email (estimate): ${templateName}`
          : `Clicked ${link || "a link"} in bulk email: ${templateName}`,
      createdBy: "broadcast",
      meta: { broadcastId: broadcastRef.id, ...(input.kind === "clicked" ? { link } : {}) },
      agencyId: send.agencyId,
      subAccountId: send.subAccountId,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.warn(
      `[broadcasts/engagement] ${input.kind} activity write failed`,
      broadcastRef.id,
      input.contactId,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * The stamp to write: the first one (the provider's time, or now), or a
 * provider time earlier than the one stored; null to leave it.
 */
function stampFor(stored: unknown, at: Timestamp | undefined): Timestamp | FieldValue | null {
  if (!stored) return at ?? FieldValue.serverTimestamp();
  if (!at) return null;
  const toMillis = (stored as { toMillis?: unknown }).toMillis;
  const storedMs =
    stored instanceof Date ? stored.getTime() : typeof toMillis === "function" ? (toMillis.call(stored) as number) : null;
  return storedMs !== null && at.toMillis() < storedMs ? at : null;
}

/**
 * Origin + path of the clicked link, for the timeline. The query and
 * fragment are dropped: they often carry tokens or personal data.
 */
function linkWithoutQuery(link: string | undefined): string {
  if (!link) return "";
  try {
    const url = new URL(link);
    return `${url.origin}${url.pathname}`.slice(0, 500);
  } catch {
    return "";
  }
}
