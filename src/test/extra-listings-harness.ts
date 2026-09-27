import { expect } from "vitest";
import { SUB, SUB_PATH, state } from "@/test/google-oauth-harness";
import { DEFAULT_ACCOUNT, LOC_A, TOKEN_MARKERS, setScenario } from "@/test/gbp-route-harness";
import { locId } from "@/lib/gbp/listings";
import { PUT } from "@/app/api/sub-accounts/[id]/google/extra-listings/route";

/**
 * Helpers for the extra-listings route tests (MULTI_LISTING_V1_PLAN.md PR 3),
 * layered on google-oauth-harness + gbp-route-harness. The fake provider sees
 * three locations under one account: LOC_A (the main), LOC_NORTH and LOC_C.
 */

export const LOC_C = "locations/e2e-velo-third";
const URL_ = `http://127.0.0.1:3100/api/sub-accounts/${SUB}/google/extra-listings`;

/** The extras as stored — what a freshly opened picker sends as `expected`. */
export function storedPairs() {
  const sub = state.docs.get(SUB_PATH) ?? {};
  const main = (sub.googleListing as { locationName?: string } | null | undefined)?.locationName;
  return ((sub.googleExtraListings ?? []) as Array<{ accountName: string; locationName: string }>)
    .filter((l) => l.locationName !== main)
    .map(({ accountName, locationName }) => ({ accountName, locationName }));
}

/** PUT the extras; a body with `listings` and no `expected` is sent as a fresh client would. */
export async function putExtras(body: unknown, uid = "uid_admin") {
  const fresh = !!body && typeof body === "object" && "listings" in body && !("expected" in body);
  const sent = fresh ? { ...body, expected: storedPairs() } : body;
  const req = new Request(URL_, {
    method: "PUT",
    headers: { "x-user-uid": uid, "content-type": "application/json" },
    body: typeof sent === "string" ? sent : JSON.stringify(sent),
  });
  const res = await PUT(req, { params: Promise.resolve({ id: SUB }) });
  const text = await res.text();
  expect(text).not.toMatch(TOKEN_MARKERS);
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
}

export const pair = (locationName: string, accountName = DEFAULT_ACCOUNT) => ({ accountName, locationName });

/** The scenario plus a third location, and SUB's main listing = LOC_A. */
export function seedMainAndScenario(opts: { legacy?: boolean } = {}) {
  setScenario((s) => {
    s.locations[DEFAULT_ACCOUNT].push({ ...s.locations[DEFAULT_ACCOUNT][0], name: LOC_C, title: "Velo Test Fibre — Third" });
  });
  state.docs.set(SUB_PATH, {
    ...state.docs.get(SUB_PATH),
    googleListing: { accountName: DEFAULT_ACCOUNT, locationName: LOC_A, title: "Main" },
    ...(opts.legacy ? {} : { googleLocationNames: [LOC_A] }),
  });
}

export const subDoc = () => state.docs.get(SUB_PATH) ?? {};
export const events = () =>
  [...state.docs.entries()].filter(([p]) => p.startsWith(`${SUB_PATH}/gbpEvents/`)).map(([, d]) => d);

const statePath = (loc: string) => `${SUB_PATH}/private/gbpSyncState${loc === LOC_A ? "" : `_${locId(loc)}`}`;

/** A synced cache for one listing: two reviews (with a draft), its summary and its sync state. */
export function seedListingCache(loc: string) {
  for (const n of [1, 2]) {
    state.docs.set(`${SUB_PATH}/gbpReviews/${locId(loc)}-${n}`, {
      subAccountId: SUB,
      locationName: loc,
      reviewId: `${locId(loc)}-${n}`,
      pendingReply: { text: "draft", createdAt: 1 },
      heldAlertBasis: "basis",
    });
  }
  state.docs.set(statePath(loc), { lease: null, pass: { passId: "p", pageToken: "3" } });
  const summary = { locationName: loc, averageRating: 4, totalReviewCount: 2 };
  const sub = subDoc();
  state.docs.set(
    SUB_PATH,
    loc === LOC_A
      ? { ...sub, gbpSummary: summary }
      : { ...sub, gbpSummaries: { ...(sub.gbpSummaries as object), [locId(loc)]: summary } },
  );
}

/** What is left of one listing's synced data. */
export function listingCacheLeft(loc: string) {
  const sub = subDoc();
  return {
    reviews: [...state.docs.entries()].filter(
      ([p, d]) => p.startsWith(`${SUB_PATH}/gbpReviews/`) && d.locationName === loc,
    ).length,
    summary:
      loc === LOC_A ? (sub.gbpSummary ?? null) : ((sub.gbpSummaries as Record<string, unknown> | undefined)?.[locId(loc)] ?? null),
    syncState: state.docs.has(statePath(loc)),
  };
}
