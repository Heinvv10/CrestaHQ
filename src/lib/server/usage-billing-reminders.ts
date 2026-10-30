import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { BillingError, commitChargeLink, stageChargeLink } from "@/lib/server/billing-service";
import { billingRecipient } from "@/lib/server/usage-billing-recipient";
import { resolveUsageSender, sendUsageEmail } from "@/lib/server/usage-billing-email";
import {
  DAY_MS,
  inPool,
  toMillis,
  UsageChargeRefused,
  type UsageRefusal,
} from "@/lib/server/usage-billing-shared";
import { localDay, USAGE_REMINDER_DAYS_BEFORE } from "@/lib/billing/usage";
import type { UsageChargeLine } from "@/types/billing";
import type { SubAccountDoc } from "@/types";

/**
 * Reminders by local calendar day, for charges whose invoice was emailed and
 * that are still pending (a cancelled or never-emailed charge is skipped). They
 * go to the CURRENT recipient, not the address the invoice went to.
 */
export async function sendDueReminders(
  now: Date,
): Promise<{ sent: number; failed: number; refusals: UsageRefusal[] }> {
  const db = getAdminDb();
  const pending = await db
    .collection("billingCharges")
    .where("kind", "==", "usage")
    .where("status", "==", "pending")
    .get();
  const today = localDay(now.getTime());
  let sent = 0;
  const { failed, refusals } = await inPool(pending.docs, async (doc) => {
    const data = doc.data();
    const dueMs = toMillis(data.dueAt);
    if (dueMs === null || !data.emailedTo) return;
    const dueDay = localDay(dueMs);
    const warnDay = localDay(dueMs - USAGE_REMINDER_DAYS_BEFORE * DAY_MS);
    // Each stage has its own stamp, so "due today" doesn't suppress the overdue notice.
    const stage: "beforeDue" | "onDue" | "overdue" | null =
      today > dueDay ? "overdue" : today === dueDay ? "onDue" : today >= warnDay ? "beforeDue" : null;
    if (!stage || data.remindedAt?.[stage]) return;
    const month = String(data.usageMonth ?? "");
    const refuse = (why: string): never => {
      throw new UsageChargeRefused(String(data.agencyId ?? ""), String(data.subAccountId), month, why);
    };
    const subSnap = await db.doc(`subAccounts/${data.subAccountId}`).get();
    if (!subSnap.exists) return;
    const sub = { ...(subSnap.data() as SubAccountDoc), id: subSnap.id };
    // Everything the send needs is resolved BEFORE the stage is stamped or a
    // link staged, so nothing is spent on a send that cannot go.
    const to = await billingRecipient(sub);
    if (!to) return refuse("no recipient to send the reminder to: set the workspace's account contact");
    const sender = await resolveUsageSender(sub.id);
    if (!sender) return refuse("no email sender is configured for this workspace");
    // Claim the stamp first so overlapping runs can't both send.
    const claimed = await db.runTransaction(async (tx) => {
      const d = (await tx.get(doc.ref)).data();
      if (!d || d.status !== "pending" || d.remindedAt?.[stage]) return false;
      tx.update(doc.ref, { [`remindedAt.${stage}`]: FieldValue.serverTimestamp() });
      return true;
    });
    if (!claimed) return;
    const release = () => doc.ref.update({ [`remindedAt.${stage}`]: FieldValue.delete() });
    const refusal = async (err: unknown): Promise<never> => {
      await release();
      if (err instanceof BillingError) return refuse(err.message);
      throw err;
    };
    // The link in this email is staged, not live: the one in the earlier email
    // keeps working until this one has gone out.
    let link: { url: string; hash: string };
    try {
      link = stageChargeLink(doc.id);
    } catch (err) {
      return refusal(err);
    }
    const ok = await sendUsageEmail({
      sender,
      kind: stage,
      to,
      sub,
      month,
      amountCents: Number(data.amountCents ?? 0),
      currency: String(data.currency ?? "usd"),
      lineItems: (data.lineItems as UsageChargeLine[] | undefined) ?? [],
      payUrl: link.url,
      dueAt: new Date(dueMs),
    });
    if (!ok) {
      // Gives the stage back so tomorrow retries; the old link is untouched.
      await release();
      return refuse("the reminder email could not be sent");
    }
    try {
      await commitChargeLink(doc.id, link.hash);
    } catch (err) {
      return refusal(err);
    }
    sent++;
  });
  return { sent, failed, refusals };
}
