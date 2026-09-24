import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { raiseChargeTask } from "@/lib/server/auto-charge-alerts";
import { schedulesCollection, sendGeneratedInvoice } from "@/lib/server/recurring-invoice-cycle";
import type { RecurringInvoiceDoc } from "@/types/recurring-invoices";

/**
 * What a card cycle does when the card is not (or cannot be) charged: note
 * the schedule, raise a Task, email the invoice instead. Split from
 * `recurring-auto-charge.ts`; the stale-charge sweep emails a late decline
 * through the same path.
 */

const EMAILED = "The invoice was emailed instead.";

export type TaskText = { title: string; notes: string };

export function chargeFallback(schedule: RecurringInvoiceDoc, invoiceId: string, label: string, tag: string) {
  const note = (lastError: string) =>
    schedulesCollection()
      .doc(schedule.id)
      .update({ lastError: lastError.slice(0, 500), updatedAt: FieldValue.serverTimestamp() })
      .catch((err: unknown) => console.error(`${tag} lastError not written`, err));
  // No redelivery re-runs a cycle, so a Task that fails to create is logged;
  // the `lastError` written beside it still tells the operator.
  const alert = (title: string, notes: string) =>
    raiseChargeTask(schedule, title, notes).catch((err: unknown) => console.error(`${tag} task not raised: ${title}`, err));
  // "emailed" only once sent. ONE Task carries every reason; a failed send always raises one.
  const emailInstead = async (why: string, task?: TaskText) => {
    await note(why);
    let res: Awaited<ReturnType<typeof sendGeneratedInvoice>> | undefined;
    try {
      res = await sendGeneratedInvoice(schedule, invoiceId, why);
      if (res.sent) await note([why, EMAILED, res.cardLinkFallback].filter(Boolean).join(" "));
      return res.sent;
    } finally {
      const failure = res?.sent ? null : (res?.error ?? "the send failed unexpectedly");
      const extra = [failure ? `Invoice not sent: ${failure}` : EMAILED, res?.cardLinkFallback].filter(Boolean).join(" ");
      if (task) await alert(task.title, `${task.notes} ${extra}`.trim());
      else if (failure) await alert(`Invoice ${label} was not sent: ${failure}`, `${why} ${extra}`);
      else if (res?.cardLinkFallback) await alert(res.cardLinkFallback, "Until a card is saved, each cycle emails its invoice instead of charging a card.");
    }
  };
  return { note, alert, emailInstead };
}
