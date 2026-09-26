/**
 * The deployment-wide kill switch for review auto-reply
 * (AUTO_REPLY_V1_PLAN.md): the engine runs ONLY when
 * `REVIEWS_AUTO_REPLY_ENABLED === "1"`. Unset (or anything else), it never
 * reads a review, drafts or posts — whatever any sub-account's settings say.
 * Read at the start of every run and again inside every post's final
 * transaction. To stop it, set it to "0" (deleting the line lets Next fall
 * back to the release dir's build-time .env.production) and restart the live
 * colour — RUNBOOK.md "Review auto-reply".
 */
export function autoReplyKillSwitchOn(): boolean {
  return process.env.REVIEWS_AUTO_REPLY_ENABLED === "1";
}
