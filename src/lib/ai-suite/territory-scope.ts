import "server-only";

import type {
  DocumentData,
  Query,
  QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import {
  loadEffectiveTerritoryScope,
  type EffectiveTerritoryScope,
} from "@/lib/auth/territory-filter";

/**
 * Territory scoping for AI Suite capabilities. The assistant reads and writes
 * with the Admin SDK, so firestore.rules' `canSeeScopedDoc` never runs — these
 * helpers apply the same rule server-side (via `loadEffectiveTerritoryScope`):
 * admins / agency owners / scoping-off sub-accounts see everything; a scoped
 * collaborator sees Global plus their assigned territories, never a doc with
 * no territory.
 */

type Doc = QueryDocumentSnapshot<DocumentData>;

/** Firestore's `in` operator takes at most 30 values. */
const IN_LIMIT = 30;

export function territoryScopeFor(ctx: {
  uid: string;
  subAccountId?: string;
  subAccountRole?: string;
}): Promise<EffectiveTerritoryScope> {
  // Any role other than admin / agencyOwner is scoped — an unknown role
  // fails closed inside loadEffectiveTerritoryScope.
  return loadEffectiveTerritoryScope({
    uid: ctx.uid,
    subAccountId: ctx.subAccountId!,
    subAccountRole: ctx.subAccountRole as "admin" | "collaborator" | "agencyOwner",
  });
}

/** True when the caller may see a doc carrying `territoryId`. */
export function canSeeTerritory(
  scope: EffectiveTerritoryScope,
  territoryId: unknown,
): boolean {
  if (!scope.enforce) return true;
  return typeof territoryId === "string" && (scope.ids ?? []).includes(territoryId);
}

function chunks(ids: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += IN_LIMIT) out.push(ids.slice(i, i + IN_LIMIT));
  return out;
}

/**
 * Run `q` restricted to the caller's visible territories, query-side. For a
 * scoped caller each ≤30-id chunk runs as its own `territoryId in [...]` query
 * (every chunk honours `q`'s limit, so a caller's visible docs are never
 * crowded out by invisible ones). Equality-only queries only — a range filter
 * plus `in` needs a composite index; use {@link collectVisible} for those.
 */
export async function scopedDocs(
  scope: EffectiveTerritoryScope,
  q: Query<DocumentData>,
): Promise<Doc[]> {
  if (!scope.enforce) return (await q.get()).docs;
  const out: Doc[] = [];
  for (const ids of chunks(scope.ids ?? [])) {
    out.push(...(await q.where("territoryId", "in", ids).get()).docs);
  }
  return out;
}

/** Aggregate count of `q`, restricted to the caller's visible territories. */
export async function scopedCount(
  scope: EffectiveTerritoryScope,
  q: Query<DocumentData>,
): Promise<number> {
  if (!scope.enforce) return (await q.count().get()).data().count;
  let total = 0;
  for (const ids of chunks(scope.ids ?? [])) {
    total += (await q.where("territoryId", "in", ids).count().get()).data().count;
  }
  return total;
}

/**
 * Page through an ORDERED query, keeping the caller's visible docs, until
 * `want` are collected or the query is exhausted. The territory filter runs
 * BEFORE the cap, so invisible docs never eat a scoped caller's result slots.
 * `scanCapped` is true when `maxScan` docs were read without exhausting the
 * query — the caller must say the answer may be incomplete.
 */
export async function collectVisible(
  scope: EffectiveTerritoryScope,
  q: Query<DocumentData>,
  opts: { want: number; maxScan: number },
): Promise<{ docs: Doc[]; scanCapped: boolean }> {
  const pageSize = Math.min(opts.maxScan, opts.want);
  const docs: Doc[] = [];
  let scanned = 0;
  let cursor: Doc | null = null;
  while (docs.length < opts.want) {
    const page: Query<DocumentData> = cursor
      ? q.startAfter(cursor).limit(pageSize)
      : q.limit(pageSize);
    const snap = await page.get();
    scanned += snap.size;
    for (const d of snap.docs) {
      if (canSeeTerritory(scope, d.data().territoryId)) docs.push(d);
    }
    if (snap.size < pageSize) return { docs: docs.slice(0, opts.want), scanCapped: false };
    if (scanned >= opts.maxScan) {
      return { docs: docs.slice(0, opts.want), scanCapped: docs.length < opts.want };
    }
    cursor = snap.docs[snap.docs.length - 1]!;
  }
  return { docs: docs.slice(0, opts.want), scanCapped: false };
}
