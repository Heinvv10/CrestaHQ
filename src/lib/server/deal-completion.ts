import "server-only";

import { maybeSendReviewRequest } from "@/lib/reviews/request";
import type { DealWriteResult } from "./deals-service";

/**
 * The Google review request a deal's completion may send: only when a Won
 * deal is FIRST marked completed. Fire-and-forget; the dispatcher re-checks
 * the sub-account's review config (enabled + triggerOnDealCompleted +
 * cooldown) before sending anything. Shared by the deal edit route and the
 * agent's approved mark_deal_completed, so both ask exactly the same way.
 */
export function askReviewIfNewlyCompleted(opts: {
  /** The deal as it was before the write. */
  before: FirebaseFirestore.DocumentData;
  completed: boolean | undefined;
  result: DealWriteResult;
}): void {
  const { before, result } = opts;
  const becameCompleted = opts.completed === true && before.completed !== true;
  if (becameCompleted && result.stageTerminal === "won") {
    void maybeSendReviewRequest({
      subAccountId: before.subAccountId as string,
      agencyId: before.agencyId as string,
      contactId: (result.deal.contact_id ?? before.contactId) as string,
      trigger: "deal_completed",
    });
  }
}
