import "server-only";

import { maybeSendReviewRequest, type SendReviewInput } from "@/lib/reviews/request";
import type { DealWriteResult } from "./deals-service";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * The Google review request a deal's completion may send: only when a Won
 * deal is FIRST marked completed. Fire-and-forget; the dispatcher re-checks
 * the sub-account's review config (enabled + triggerOnDealCompleted +
 * cooldown) before sending anything. Shared by the deal edit route and the
 * agent's approved mark_deal_completed, so both ask exactly the same way.
 */
export function askReviewIfNewlyCompleted(opts: {
  /** The deal as it was before the write (for its tenant and contact). */
  before: FirebaseFirestore.DocumentData;
  completed: boolean | undefined;
  result: DealWriteResult;
  /** An approved agent completion: the reviewed number and channel. */
  expect?: SendReviewInput["expect"];
}): void {
  const { before, result } = opts;
  // "Was it already completed?" from the write's own transaction: of two
  // writers completing it at once, only one sees "not yet".
  const becameCompleted = opts.completed === true && result.previousCompleted !== true;
  if (becameCompleted && result.stageTerminal === "won") {
    runAfterResponse(() => maybeSendReviewRequest({
      subAccountId: before.subAccountId as string,
      agencyId: before.agencyId as string,
      contactId: (result.deal.contact_id ?? before.contactId) as string,
      trigger: "deal_completed",
      ...(opts.expect ? { expect: opts.expect } : {}),
    }));
  }
}
