import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { sendSmsForSubAccount } from "@/lib/comms/twilio";
import { sendWhatsappFreeFormForSubAccount } from "@/lib/comms/whatsapp/send-dispatch";
import { smsSendBlock } from "@/lib/comms/sms-consent";
import { isQuietHoursDeferred } from "@/lib/comms/quiet-hours";
import {
  holdForQuietHours,
  writeHoldActivity,
  type HeldMessage,
  type HoldDoc,
} from "@/lib/comms/quiet-hours-hold";
import { maybeSendReviewRequest } from "@/lib/reviews/request";
import {
  getConversationControls,
  upsertConversationForMessage,
} from "@/lib/server/conversations-service";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";

export type ReleaseResult =
  | { outcome: "skipped"; reason: string }
  | { outcome: "released" }
  | { outcome: "failed"; reason: string };

/**
 * Release one quiet-hours hold (the QStash worker's body). Claimed pending →
 * releasing in a transaction; only the delivery that wins the claim sends, and
 * a claimed hold is never retried (at most once, like scheduled messages).
 *
 * Nothing is trusted from hold time. A review request re-runs the whole
 * dispatcher (opt-out, cooldown, gates, rail). A held message re-reads the
 * contact and re-checks its opt-out, and an AI reply is dropped if the bot
 * was paused or turned off on the conversation meanwhile — a person has
 * picked it up. Still inside quiet hours (the window was changed)? It is held
 * again, not sent.
 */
export async function releaseQuietHoursHold(
  subAccountId: string,
  holdId: string,
): Promise<ReleaseResult> {
  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${subAccountId}/quietHoursHolds/${holdId}`);
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const doc = snap.data() as HoldDoc;
    if (doc.status !== "pending") return doc.status;
    tx.update(ref, { status: "releasing", updatedAt: FieldValue.serverTimestamp() });
    return doc;
  });
  if (claimed === null) return { outcome: "skipped", reason: "missing" };
  if (typeof claimed === "string") return { outcome: "skipped", reason: `status:${claimed}` };

  const settle = async (r: ReleaseResult): Promise<ReleaseResult> => {
    await ref.update({
      status: r.outcome,
      outcome: r.outcome === "released" ? null : r.reason,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return r;
  };

  const { payload } = claimed;
  if (payload.kind === "review_request") {
    // Held again inside, if it must be: the dispatcher parks its own re-hold.
    const res = await maybeSendReviewRequest(payload.request);
    return settle(res.sent ? { outcome: "released" } : { outcome: "skipped", reason: res.reason ?? "not_sent" });
  }
  return settle(await releaseMessage(claimed, payload.message));
}

async function releaseMessage(hold: HoldDoc, m: HeldMessage): Promise<ReleaseResult> {
  const db = getAdminDb();
  const [subSnap, contactSnap] = await Promise.all([
    db.doc(`subAccounts/${hold.subAccountId}`).get(),
    db.doc(`contacts/${m.contactId}`).get(),
  ]);
  const subAccount = subSnap.exists ? (subSnap.data() as SubAccountDoc) : null;
  if (!subAccount) return { outcome: "skipped", reason: "no_sub_account" };
  if (!contactSnap.exists || contactSnap.data()?.subAccountId !== hold.subAccountId) {
    return { outcome: "skipped", reason: "no_contact" };
  }
  const contact = { id: contactSnap.id, ...(contactSnap.data() as Omit<Contact, "id">) };
  const label = m.source === "ai_reply" ? "AI reply" : "Missed-call text-back";

  const optedOut =
    m.channel === "sms" ? smsSendBlock(contact) !== null : contact.whatsappOptedOut === true;
  if (optedOut) {
    await writeHoldActivity(contact.id, `${label} held for quiet hours was not sent — the contact opted out meanwhile.`);
    return { outcome: "skipped", reason: "opted_out" };
  }
  if (m.source === "ai_reply") {
    const controls = await getConversationControls(contact.id);
    if ((controls.botPausedUntilMs ?? 0) > Date.now() || controls.botMode !== "auto") {
      await writeHoldActivity(contact.id, `${label} held for quiet hours was not sent — the bot was paused or switched off on this conversation meanwhile.`);
      return { outcome: "skipped", reason: "bot_off" };
    }
  }

  let sid: string;
  let from: string;
  try {
    const r =
      m.channel === "sms"
        ? await sendSmsForSubAccount({ subAccountId: hold.subAccountId, subAccount, to: m.to, body: m.body })
        : await sendWhatsappFreeFormForSubAccount({
            subAccountId: hold.subAccountId,
            subAccount,
            contactId: contact.id,
            to: m.to,
            body: m.body,
            senderId: m.senderId ?? null,
          });
    sid = r.sid;
    from = r.from;
  } catch (err) {
    if (isQuietHoursDeferred(err)) {
      const held = await holdForQuietHours({
        agencyId: hold.agencyId,
        subAccountId: hold.subAccountId,
        payload: { kind: "message", message: m },
        hold: err.hold,
      });
      return { outcome: "skipped", reason: held ? "held_again" : "hold_failed" };
    }
    const msg = err instanceof Error ? err.message : "send_failed";
    await writeHoldActivity(contact.id, `${label} held for quiet hours failed to send: ${msg.slice(0, 200)}`);
    return { outcome: "failed", reason: msg.slice(0, 500) };
  }

  // The thread row + inbox index the original sender would have written.
  try {
    await db
      .doc(`contacts/${contact.id}/${m.channel === "sms" ? "messages" : "whatsappMessages"}/${sid || db.collection("contacts").doc().id}`)
      .set(
        {
          agencyId: hold.agencyId,
          subAccountId: hold.subAccountId,
          contactId: contact.id,
          direction: "outbound",
          status: "sent",
          body: m.body,
          from,
          to: m.to,
          twilioMessageSid: sid || null,
          sentByUid: m.source === "ai_reply" ? "ai" : null,
          ...(m.source === "ai_reply" ? { aiGenerated: true } : {}),
          error: null,
          readAt: null,
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    await upsertConversationForMessage({
      contactId: contact.id,
      subAccountId: hold.subAccountId,
      agencyId: hold.agencyId,
      contactName: contact.name ?? "",
      contactPhone: contact.phone ?? m.to,
      channel: m.channel,
      direction: "outbound",
      body: m.body,
    });
  } catch (err) {
    console.warn("[quiet-hours] message-row / inbox write failed", err);
  }
  await writeHoldActivity(contact.id, `${label} held for quiet hours was sent.`);
  return { outcome: "released" };
}
