import "server-only";

import { unstable_cache } from "next/cache";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  coerceCohortState,
  emptyCohortState,
  type FoundersCohortState,
} from "@/lib/landing/cohort-state";
import {
  DEAL_STATE_TAG,
  DEAL_STATE_REVALIDATE_SECONDS,
} from "@/lib/landing/deal-cache";

/**
 * Server-side read of the live deal state (`appConfig/foundersCohort`),
 * CACHED (tag-busted by the Deal editor's save) so the high-traffic public
 * landing costs ~0 Firestore reads for it.
 *
 * Why the landing needs this at all when it ALSO subscribes client-side:
 * the client subscription takes ~1-3s to connect, and until it does the
 * pre-hydration defaults say "deal is live" — so a retail-mode page rendered
 * "Claim your spot — $891" first and then jumped to "Buy Now — $1,782". A
 * price that rises while the visitor is reading it destroys trust. Seeding
 * the first paint from the server means the very first HTML already carries
 * the correct price; the subscription then only ever applies real edits.
 *
 * Returns null when the read fails (Firebase unconfigured, permissions, cold
 * outage) — the client hook then keeps its pre-hydration defaults exactly as
 * before, so this can only improve on the old behavior, never break it.
 */
async function readDealState(): Promise<FoundersCohortState | null> {
  try {
    const snap = await getAdminDb().doc("appConfig/foundersCohort").get();
    if (!snap.exists) return emptyCohortState();
    return coerceCohortState(snap.data() as Record<string, unknown>);
  } catch (err) {
    console.error("[deal-state-server] read failed", err);
    return null;
  }
}

export const getDealStateCached = unstable_cache(
  readDealState,
  ["deal-state"],
  {
    tags: [DEAL_STATE_TAG],
    revalidate: DEAL_STATE_REVALIDATE_SECONDS,
  },
);
