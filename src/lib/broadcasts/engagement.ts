import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import type { BroadcastSendDoc, SubAccountDoc } from "@/types";

/**
 * Record one open or click on a broadcast send row — the write behind our
 * own pixel and click redirect. Same fields as upstream's Resend handler
 * (lib/comms/email-events.ts), so the stats page reads one shape whatever
 * measured it:
 *   - first open  → `openedAt`, `totals.opened` +1; every open → `opens` +1
 *   - first click → `clickedAt`, `totals.clicked` +1; every click → `clicks` +1.
 *     A click with no open yet also stamps `openedAt` (the pixel was blocked).
 * The "first" decision and the totals move in one transaction, so a burst of
 * opens counts the recipient once. Per-row counters stop at
 * ENGAGEMENT_COUNT_CAP — a replayed token can't grow them without bound.
 *
 * Nothing is written unless the row was sent and the sub-account still has
 * that kind of tracking on: switching it off stops collection for emails
 * already out.
 *
 * On the first occurrence only, an `email_opened` / `email_clicked` activity
 * lands on the contact. No workflow trigger fires here (I3 adds those).
 */

export const ENGAGEMENT_COUNT_CAP = 100;

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
}): Promise<void> {
  const db = getAdminDb();
  const broadcastRef = db.collection("broadcasts").doc(input.broadcastId);
  const sendRef = broadcastRef.collection("sends").doc(input.contactId);
  const trackingKey = input.kind === "opened" ? "opens" : "clicks";

  const outcome = await db.runTransaction(async (tx): Promise<Outcome> => {
    const snap = await tx.get(sendRef);
    if (!snap.exists) return { first: false, send: null };
    const send = snap.data() as BroadcastSendDoc;
    if (send.status !== "sent" || !send.subAccountId) return { first: false, send: null };
    const sub = (await tx.get(db.collection("subAccounts").doc(send.subAccountId))).data() as
      | SubAccountDoc
      | undefined;
    if (sub?.emailTracking?.[trackingKey] !== true) return { first: false, send: null };

    if (input.kind === "opened") {
      const first = !send.openedAt;
      const room = (send.opens ?? 0) < ENGAGEMENT_COUNT_CAP;
      if (!first && !room) return { first: false, send };
      tx.update(sendRef, {
        ...(first ? { openedAt: FieldValue.serverTimestamp() } : {}),
        ...(room ? { opens: FieldValue.increment(1) } : {}),
      });
      if (first) tx.update(broadcastRef, { "totals.opened": FieldValue.increment(1) });
      return { first, send };
    }

    const first = !send.clickedAt;
    const impliedOpen = !send.openedAt;
    const room = (send.clicks ?? 0) < ENGAGEMENT_COUNT_CAP;
    if (!first && !room) return { first: false, send };
    tx.update(sendRef, {
      ...(first ? { clickedAt: FieldValue.serverTimestamp() } : {}),
      ...(impliedOpen ? { openedAt: FieldValue.serverTimestamp() } : {}),
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
    const link = (input.link ?? "").slice(0, 500);
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
