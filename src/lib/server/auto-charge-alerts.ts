import "server-only";

import { createTaskServerSide } from "@/lib/server/tasks-service";

/**
 * Anything about a saved-card charge that needs a human becomes a Task, the
 * way arrears escalation does. `schedule.lastError` is not enough on its own:
 * the next claim, and any edit, clears it — so an unknown charge or a refund
 * owed would be gone before anyone read it. A Task stays until completed.
 *
 * Callers raise one only on a path that runs once (the attempt being created,
 * or its reason first changing), so a webhook redelivery adds no duplicate.
 * Throws: the webhook rolls its reason back and asks for a redelivery; the
 * charge cycle, which nothing re-runs, logs it.
 */
export async function raiseChargeTask(
  owner: { agencyId: string; subAccountId: string; createdByUid: string; contactId: string | null },
  title: string,
  notes: string,
): Promise<void> {
  await createTaskServerSide({
    agencyId: owner.agencyId,
    subAccountId: owner.subAccountId,
    createdByUid: owner.createdByUid,
    contactId: owner.contactId,
    title,
    notes,
    dueAt: new Date(),
    dealId: null,
    eventId: null,
    // Real money, or real doubt about it — the same as the arrears Task.
    mode: "live",
  });
}

/**
 * A card-mode invoice was sent without its card-on-file link (`message` says
 * why, and which rail was used instead), so no card will be saved. Nothing
 * re-runs the send, so a Task that fails to create is logged, not thrown.
 */
export async function alertCardLinkFallback(
  schedule: Parameters<typeof raiseChargeTask>[0] & { id: string },
  message: string,
): Promise<void> {
  await raiseChargeTask(
    schedule,
    message,
    "Until a card is saved, each cycle emails its invoice instead of charging a card. Fix the reason above so the next invoice carries the card-on-file link.",
  ).catch((err: unknown) => console.error(`[recurring] schedule ${schedule.id}: task not raised: ${message}`, err));
}
