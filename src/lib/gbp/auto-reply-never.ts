/**
 * `subAccounts/{sa}/autoReplyNever/{reviewDocId}` — the durable "never
 * auto-reply to this review" marker (AUTO_REPLY_V1_PLAN.md rev 5). Written
 * wherever a review is first known to have a reply (the sync, a posted reply,
 * a finalized auto post) and never deleted: it lives OUTSIDE the review cache,
 * so a cache clear (Google gate toggle, listing change) cannot make the engine
 * forget a reply someone deleted or a reply it already posted. An id and a
 * reason only — no Google content — so it deliberately outlives review
 * retention. Server-only (no client rule: default deny).
 */

export type NeverReason = "replied" | "auto_replied";

export const autoReplyNeverCollection = (sa: string) => `subAccounts/${sa}/autoReplyNever`;
export const autoReplyNeverPath = (sa: string, docId: string) => `${autoReplyNeverCollection(sa)}/${docId}`;

export function neverMarker(
  t: { agencyId: string; subAccountId: string; createdByUid: string | null },
  reason: NeverReason,
  at: Date,
): Record<string, unknown> {
  return { agencyId: t.agencyId, subAccountId: t.subAccountId, createdByUid: t.createdByUid, reason, at };
}
