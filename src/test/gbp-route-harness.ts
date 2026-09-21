import { SECRET_PATH, SUB_PATH, state } from "@/test/google-oauth-harness";
import type { FakeScenario } from "@/lib/gbp/provider/fake-scenario";
import { defaultFakeScenario } from "@/lib/gbp/provider/fake-scenario";

/**
 * Helpers for GBP route tests, layered on google-oauth-harness. Routes run in
 * FAKE provider mode, so the real selection fence, the real token lifecycle
 * and the real fake provider all execute — only Firestore is faked.
 */

export const SCOPE = "https://www.googleapis.com/auth/business.manage";
export const DEFAULT_ACCOUNT = "accounts/e2e-fixture-group";
export const LOC_A = "locations/e2e-velo-gqeberha";
export const LOC_NORTH = "locations/e2e-velo-gqeberha-north";

export function enableFakeMode(agencyId = "ag_1") {
  process.env.GBP_PROVIDER = "fake";
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  process.env.GBP_FAKE_AGENCY_ID = agencyId;
}

/** A live connection on SUB: valid fake access token, connected meta. */
export function seedConnection(opts: { expired?: boolean; reconnectRequired?: boolean } = {}) {
  state.docs.set(SECRET_PATH, {
    refreshToken: "fake-refresh:sa_1:900",
    accessToken: "fake-access:sa_1:900",
    accessTokenExpiresAt: Date.now() + (opts.expired ? -1000 : 3_600_000),
    scopes: [SCOPE],
  });
  state.docs.set(SUB_PATH, {
    ...state.docs.get(SUB_PATH),
    googleConnectionMeta: {
      connected: true,
      email: null,
      scopes: [SCOPE],
      connectedByUid: "uid_admin",
      ...(opts.reconnectRequired ? { reconnectRequired: true, reconnectReason: "revoked" } : {}),
    },
  });
}

export function setScenario(mutate: (s: FakeScenario) => void, sub = "sa_1") {
  const s = defaultFakeScenario();
  mutate(s);
  state.docs.set(`subAccounts/${sub}/private/gbpFakeScenario`, s as unknown as Record<string, unknown>);
}

/** Every string that would betray a credential in a browser payload. */
export const TOKEN_MARKERS = /fake-refresh|fake-access|refreshToken|accessToken|ya29\.|1\/\/0g/;

/** A synced review cache (reviews, summary, sync state) on `sub`. */
export function seedSyncedCache(sub = "sa_1") {
  for (const id of ["r1", "r2"]) {
    state.docs.set(`subAccounts/${sub}/gbpReviews/${id}`, { subAccountId: sub, reviewId: id, comment: "cached" });
  }
  state.docs.set(`subAccounts/${sub}/private/gbpSyncState`, { lease: null, pass: { passId: "p", pageToken: "3" } });
  state.docs.set(`subAccounts/${sub}`, {
    ...state.docs.get(`subAccounts/${sub}`),
    gbpSummary: { locationName: LOC_A, averageRating: 4, totalReviewCount: 2, health: "ok" },
  });
}

/** What is left of that cache. */
export function cacheLeft(sub = "sa_1") {
  return {
    reviews: [...state.docs.keys()].filter((p) => p.startsWith(`subAccounts/${sub}/gbpReviews/`)).length,
    summary: state.docs.get(`subAccounts/${sub}`)?.gbpSummary ?? null,
    syncState: state.docs.has(`subAccounts/${sub}/private/gbpSyncState`),
  };
}
export const CLEARED = { reviews: 0, summary: null, syncState: false };
