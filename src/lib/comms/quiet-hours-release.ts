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
import { resolveAgent } from "@/lib/comms/ai/agent";
import { aiChannelGateOn } from "@/lib/comms/ai/gates";
import { normalizePhoneE164 } from "@/lib/contacts/phone";
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
  let result: ReleaseResult;
  try {
    if (payload.kind === "review_request") {
      // Held again inside, if it must be: the dispatcher parks its own re-hold.
      const res = await maybeSendReviewRequest(payload.request);
      result = res.sent ? { outcome: "released" } : { outcome: "skipped", reason: res.reason ?? "not_sent" };
    } else {
      result = await releaseMessage(claimed, payload.message);
    }
  } catch (err) {
    // Every throw in there comes before the provider call (the send's own
    // failures are caught and settled below it), so nothing went out: hand
    // the claim back and let QStash retry, rather than leave the hold
    // "releasing" forever with nobody the wiser.
    await ref
      .update({ status: "pending", updatedAt: FieldValue.serverTimestamp() })
      .catch((e: unknown) => console.error("[quiet-hours] claim release failed", e));
    await writeHoldActivity(
      claimed.contactId,
      "A message held for quiet hours could not be released just now; it will be retried.",
      `qh_${holdId}_retry`,
    );
    throw err;
  }
  return settle(result);
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
  const notSent = async (reason: string, why: string): Promise<ReleaseResult> => {
    await writeHoldActivity(contact.id, `${label} held for quiet hours was not sent — ${why}.`);
    return { outcome: "skipped", reason };
  };

  // The switches the original sender checked, as they stand now.
  if (m.source === "ai_reply") {
    const agent = await resolveAgent(hold.subAccountId, m.channel);
    if (!aiChannelGateOn(subAccount, m.channel) || !agent?.effective.enabled) {
      return notSent("ai_disabled", "the AI agent was switched off meanwhile");
    }
  } else if (
    subAccount.missedCallTextBackEnabledByAgency !== true ||
    !subAccount.twilioConfig?.missedCall?.enabled
  ) {
    return notSent("mctb_disabled", "missed-call text-back was switched off meanwhile");
  }
  if (m.channel === "sms" && normalizePhoneE164(contact.phone ?? "") !== normalizePhoneE164(m.to)) {
    return notSent("number_changed", "the contact's number changed meanwhile");
  }

  const optedOut =
    m.channel === "sms" ? smsSendBlock(contact) !== null : contact.whatsappOptedOut === true;
  if (optedOut) return notSent("opted_out", "the contact opted out meanwhile");
  if (m.source === "ai_reply") {
    const controls = await getConversationControls(contact.id);
    if ((controls.botPausedUntilMs ?? 0) > Date.now() || controls.botMode !== "auto") {
      return notSent("bot_off", "the bot was paused or switched off on this conversation meanwhile");
    }
    // The contact wrote again after this reply was held: that message got
    // (or is holding) its own, newer reply, and this one answers a stale turn.
    const lastInbound = await lastInboundMs(contact.id, m.channel);
    const heldAtMs = toMs(hold.heldAt);
    if (lastInbound !== null && heldAtMs !== null && lastInbound > heldAtMs) {
      return notSent("newer_inbound", "the contact wrote again after it was held");
    }
  }

  let sid: string;
  let from: string;
  // Shared-sender SMS writes no thread (the inbound webhook could never
  // attribute a reply) — the same rule the workflow and review senders keep.
  let writeThread = true;
  try {
    if (m.channel === "sms") {
      const r = await sendSmsForSubAccount({ subAccountId: hold.subAccountId, subAccount, to: m.to, body: m.body });
      sid = r.sid;
      from = r.from;
      writeThread = r.mode === "dedicated";
    } else {
      const r = await sendWhatsappFreeFormForSubAccount({
        subAccountId: hold.subAccountId,
        subAccount,
        contactId: contact.id,
        to: m.to,
        body: m.body,
        senderId: m.senderId ?? null,
      });
      sid = r.sid;
      from = r.from;
    }
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
  if (writeThread) try {
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

function toMs(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  const t = v as { toMillis?: () => number } | null | undefined;
  return t && typeof t.toMillis === "function" ? t.toMillis() : null;
}

/** When the contact last wrote on this channel's thread. */
async function lastInboundMs(contactId: string, channel: "sms" | "whatsapp"): Promise<number | null> {
  const snap = await getAdminDb()
    .collection(`contacts/${contactId}/${channel === "sms" ? "messages" : "whatsappMessages"}`)
    .orderBy("createdAt", "desc")
    .limit(20)
    .get();
  for (const d of snap.docs) {
    const row = d.data() as { direction?: string; createdAt?: unknown };
    if (row.direction === "inbound") return toMs(row.createdAt);
  }
  return null;
}
