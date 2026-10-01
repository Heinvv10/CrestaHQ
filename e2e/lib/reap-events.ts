import { adminDb } from "./admin";
import { deleteScoped, fixtureSubAccountIds } from "./guard";

/**
 * Events reaper for the fixture sub-accounts. Several specs leave their
 * events behind (appointment-status.spec's "E2E Status Booking X/Y", the
 * booking widget's "E2E fixture — 30 min booking — E2E Widget Visitor"):
 * 1,894 of them on the primary fixture by 2026-09-29, which slowed every
 * events listener in the suite.
 *
 * Every spec titles its events "E2E …", so that prefix is the match. Only
 * docs older than EVENT_STALE_MS go — the same window the specs use for
 * their own crash cleanup — so a concurrent run's live fixture (all runs
 * share one tenant, see run-id.ts) is never swept from under it.
 */

export const E2E_EVENT_TITLE_PREFIX = "E2E ";
export const EVENT_STALE_MS = 6 * 3600_000;
const DELETE_CONCURRENCY = 25;

export function isReapableEvent(data: Record<string, unknown>, nowMs: number): boolean {
  const title = typeof data.title === "string" ? data.title : "";
  if (!title.startsWith(E2E_EVENT_TITLE_PREFIX)) return false;
  const createdAt = data.createdAt as { toMillis?: () => number } | undefined;
  if (typeof createdAt?.toMillis !== "function") return false;
  return nowMs - createdAt.toMillis() > EVENT_STALE_MS;
}

/**
 * Throws before any query when `subAccountId` is not a fixture. deleteScoped
 * would still refuse each doc, but only after this had listed a client's
 * events — refusing up front means the reaper never reads them at all.
 */
export function assertReapableSubAccount(subAccountId: string): void {
  if (!fixtureSubAccountIds().includes(subAccountId)) {
    throw new Error(
      `reapStaleE2eEvents: ${subAccountId} is not a fixture sub-account. Refusing to run.`,
    );
  }
}

/** Delete this fixture sub-account's stale E2E events; returns how many. */
export async function reapStaleE2eEvents(
  subAccountId: string,
  nowMs: number = Date.now(),
): Promise<number> {
  assertReapableSubAccount(subAccountId);
  const snap = await adminDb()
    .collection("events")
    .where("subAccountId", "==", subAccountId)
    .get();
  const doomed = snap.docs.filter((d) => isReapableEvent(d.data(), nowMs));
  for (let i = 0; i < doomed.length; i += DELETE_CONCURRENCY) {
    await Promise.all(
      doomed.slice(i, i + DELETE_CONCURRENCY).map((d) => deleteScoped(d.ref)),
    );
  }
  return doomed.length;
}
