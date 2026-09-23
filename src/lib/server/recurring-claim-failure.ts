import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { schedulesCollection } from "@/lib/server/recurring-invoice-cycle";

/**
 * What to do when claiming a schedule throws.
 *
 * Bad stored data (a timezone or cadence the arithmetic rejects) throws on
 * every sweep, so failing the whole sweep over it would block every schedule
 * after it, daily. That kind fails alone. A transient Firestore error is the
 * opposite: retrying the same day is exactly right, so it still fails the
 * sweep and QStash retries.
 */

/** gRPC codes Firestore uses for "try again": the sweep should be retried. */
const TRANSIENT_CODES = new Set<number | string>([
  4, "deadline-exceeded", "DEADLINE_EXCEEDED",
  8, "resource-exhausted", "RESOURCE_EXHAUSTED",
  10, "aborted", "ABORTED",
  13, "internal", "INTERNAL",
  14, "unavailable", "UNAVAILABLE",
]);

export function isTransientClaimError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return (typeof code === "number" || typeof code === "string") && TRANSIENT_CODES.has(code);
}

/**
 * Record a claim failure on the schedule, where the operator looks.
 *
 * Non-retryable: `lastFailedAt` keeps today's continuations off it. Transient:
 * no `lastFailedAt` (the retry must reach it), but the trace is written anyway
 * — the transaction may have committed before the error surfaced, advancing
 * the schedule without an invoice, and a retry would then find it not due.
 */
export async function recordClaimFailure(
  scheduleId: string,
  err: unknown,
  now: Date,
): Promise<{ transient: boolean; reason: string }> {
  const reason = err instanceof Error ? err.message : String(err);
  const transient = isTransientClaimError(err);
  console.error(
    `[recurring] claim failed for ${scheduleId} (${transient ? "transient — sweep will retry; the claim may have committed" : "isolated"}): ${reason}`,
  );
  await schedulesCollection()
    .doc(scheduleId)
    .update({
      lastError: (transient
        ? `A run hit a temporary error and may not have raised this cycle's invoice: ${reason}. Check the invoices and raise it by hand if missing.`
        : `This schedule could not run: ${reason}`
      ).slice(0, 500),
      ...(transient ? {} : { lastFailedAt: Timestamp.fromDate(now) }),
      updatedAt: FieldValue.serverTimestamp(),
    })
    .catch((writeErr) =>
      console.error(`[recurring] could not record failure for ${scheduleId}`, writeErr),
    );
  return { transient, reason };
}
