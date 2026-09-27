import { claims, mem } from "@/test/gbp-sync-store";
import type { GbpReview } from "@/lib/gbp/provider/types";
import {
  defaultFakeScenario,
  fakeScenarioPath,
  type FakeScenario,
} from "@/lib/gbp/provider/fake-scenario";

/**
 * Seam harness for the review sync: an in-memory Firestore that honours
 * queries and transactions (memory-firestore.ts), real `require-tenancy` on
 * top of it, and PR 1's REAL fake provider reached through the real
 * `getGbpProviderFor` fence — its scenario lives at
 * `private/gbpFakeScenario` in the same in-memory store. Nothing between the
 * route and Firestore is mocked.
 *
 * Usage in a test file:
 *   vi.mock("@/lib/firebase/admin", async () =>
 *     (await import("@/test/gbp-sync-store")).adminMock());
 */

export { claims, mem } from "@/test/gbp-sync-store";

export const AGENCY = "ag_1";
export const FOREIGN_AGENCY = "ag_real";
export const SA = "sa_1";
export const OTHER_SA = "sa_2";
/** A sub-account of ANOTHER agency — the fake must never touch it. */
export const FOREIGN_SA = "sa_foreign";
export const ACCOUNT = "accounts/e2e-fixture-group";
export const LOC_A = "locations/e2e-velo-gqeberha";
export const LOC_NORTH = "locations/e2e-velo-gqeberha-north";
export const SCOPE = "https://www.googleapis.com/auth/business.manage";
export const NOW = new Date("2026-09-11T10:00:00Z");

/** Every string that must never reach a browser from these routes. */
export const LEAK_MARKERS = /fake-refresh|fake-access|refreshToken|accessToken|passId|contentHash|gbpSyncState|"lease"|"pageToken"/;

export interface SubOpts {
  agencyId?: string;
  gateOn?: boolean;
  connected?: boolean;
  listing?: string | null;
  reconnectRequired?: boolean;
}

/** A sub-account with a fresh fake connection and the first fixture location selected. */
export function seedSub(sa: string, opts: SubOpts = {}) {
  const connected = opts.connected ?? true;
  const listing = opts.listing === undefined ? LOC_A : opts.listing;
  mem.seed(`subAccounts/${sa}`, {
    agencyId: opts.agencyId ?? AGENCY,
    googleEnabledByAgency: opts.gateOn ?? true,
    googleConnectionMeta: connected
      ? {
          connected: true,
          email: null,
          scopes: [SCOPE],
          connectedByUid: "uid_admin",
          ...(opts.reconnectRequired ? { reconnectRequired: true, reconnectReason: "revoked" } : {}),
        }
      : null,
    googleListing: listing
      ? {
          accountName: ACCOUNT,
          accountDisplayName: "E2E Fixture Group",
          locationName: listing,
          title: "Velo Test Fibre — Gqeberha",
          address: "1 Fixture Road",
          websiteUri: null,
          placeId: null,
          mapsUri: null,
          newReviewUri: null,
          selectedAt: NOW,
          selectedByUid: "uid_admin",
        }
      : null,
  });
  if (connected) {
    mem.seed(`subAccounts/${sa}/private/googleConnection`, {
      refreshToken: `fake-refresh:${sa}:900`,
      accessToken: `fake-access:${sa}:900`,
      accessTokenExpiresAt: Date.now() + 3_600_000,
      scopes: [SCOPE],
    });
  }
}

function member(sa: string, uid: string, role: string) {
  mem.seed(`subAccounts/${sa}/subAccountMembers/${uid}`, { status: "active", subAccountRole: role, role });
  claims.set(uid, { status: "active", agencyId: AGENCY, agencyRole: null });
}

/** Fresh store: SA (admin, collaborator), OTHER_SA (its own admin), fake mode on. */
export function resetSync(opts: SubOpts = {}) {
  mem.clear();
  claims.clear();
  process.env.GBP_PROVIDER = "fake";
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  process.env.GBP_FAKE_AGENCY_ID = AGENCY;
  seedSub(SA, opts);
  seedSub(OTHER_SA);
  member(SA, "uid_admin", "admin");
  member(SA, "uid_collab", "collaborator");
  member(OTHER_SA, "uid_other_admin", "admin");
  // Signed in and active, but a member of nothing.
  claims.set("uid_stranger", { status: "active", agencyId: AGENCY, agencyRole: null });
}

/** A request as `uid` (the middleware's x-user-uid header). */
export function asUser(url: string, uid: string, method = "GET", body?: string) {
  return new Request(url, { method, headers: { "x-user-uid": uid }, body });
}

export function setScenario(sa: string, mutate: (s: FakeScenario) => void) {
  const current = mem.read(fakeScenarioPath(sa)) as FakeScenario | undefined;
  const s = current ?? defaultFakeScenario();
  mutate(s);
  mem.seed(fakeScenarioPath(sa), s as unknown as Record<string, unknown>);
}

/** A review at Google on `loc` (the fake's review names carry their location). */
export function reviewOn(loc: string, id: string, starRating: GbpReview["starRating"], day: number, reply?: string): GbpReview {
  const time = `2026-08-${String(day).padStart(2, "0")}T09:00:00Z`;
  return {
    name: `${ACCOUNT}/${loc}/reviews/${id}`, reviewId: id,
    reviewer: { displayName: `Fixture Reviewer ${id}`, profilePhotoUrl: null, isAnonymous: false },
    starRating, comment: `Fixture review ${id}.`, createTime: time, updateTime: time,
    reply: reply ? { comment: reply, updateTime: time } : null,
  };
}

/**
 * Connect `loc` (default: the fake's second location) as an EXTRA listing of
 * `sa` (MULTI_LISTING_V1_PLAN.md) — `googleExtraListings` + the flat
 * `googleLocationNames` — and give it these reviews at Google (default: 3).
 */
export function seedExtraListing(sa: string, loc = LOC_NORTH, list?: GbpReview[]) {
  const sub = mem.read(`subAccounts/${sa}`)!;
  const main = sub.googleListing as { locationName: string } & Record<string, unknown>;
  const extra = { ...main, locationName: loc, title: "Velo Test Fibre — Gqeberha North" };
  mem.seed(`subAccounts/${sa}`, { ...sub, googleExtraListings: [extra], googleLocationNames: [main.locationName, loc] });
  const on = list ?? [reviewOn(loc, "north-3", 5, 20), reviewOn(loc, "north-2", 4, 14), reviewOn(loc, "north-1", 2, 8)];
  setScenario(sa, (s) => void (s.reviews[loc] = { averageRating: 3.7, totalReviewCount: on.length, reviews: on }));
}

/** Drop the extra listings from `sa`'s doc (what PR 3's removal writes before it clears). */
export function removeExtraListings(sa: string) {
  const sub = mem.read(`subAccounts/${sa}`)!;
  mem.seed(`subAccounts/${sa}`, { ...sub, googleExtraListings: [], googleLocationNames: [(sub.googleListing as { locationName: string }).locationName] });
}

export const reviews = (sa = SA) => mem.list(`subAccounts/${sa}/gbpReviews`);
export const activeReviews = (sa = SA) => reviews(sa).filter((r) => r.state === "active");
export const runs = (sa = SA) => mem.list(`subAccounts/${sa}/gbpSyncRuns`);
export const summaryOf = (sa = SA) => mem.read(`subAccounts/${sa}`)?.gbpSummary as Record<string, unknown> | null | undefined;
export const syncState = (sa = SA) => mem.read(`subAccounts/${sa}/private/gbpSyncState`);

/** A sleep that records its waits and never actually waits. */
export function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}
