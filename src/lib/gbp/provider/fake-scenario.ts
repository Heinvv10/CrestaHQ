import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type {
  GbpAccount,
  GbpDailyMetric,
  GbpLocation,
  GbpProviderErrorKind,
  GbpReview,
} from "./types";

/**
 * Scenario data for the fake provider. Obviously fake on purpose: no real
 * person, business, address or Place ID appears here.
 */

export type FakeOp =
  | "exchangeCode"
  | "refresh"
  | "revoke"
  | "listAccounts"
  | "listLocations"
  | "listReviews"
  | "putReply"
  | "deleteReply"
  | "fetchDailyMetrics";

export interface FakeScenario {
  revoked?: boolean;
  rotateRefreshToken?: boolean;
  accounts: GbpAccount[];
  /** Keyed by account name (`accounts/…`). */
  locations: Record<string, GbpLocation[]>;
  /** Keyed by location name (`locations/…`). */
  reviews: Record<
    string,
    { averageRating: number | null; totalReviewCount: number | null; reviews: GbpReview[] }
  >;
  /** Fail the next call of `op` once with `kind`, then clear. */
  failNext?: { op: FakeOp; kind: GbpProviderErrorKind };
  /**
   * Fail `listReviews` for ONE page (`pageToken`, null = the first page) with
   * `kind` — `times` more calls, then clear; forever when `times` is absent.
   * What a sync that fails halfway through a pass looks like.
   */
  failReviewsPage?: { pageToken: string | null; kind: GbpProviderErrorKind; times?: number };
  /**
   * What reviews pages AFTER the first report as averageRating /
   * totalReviewCount (null = omitted), instead of the location's values.
   */
  laterPages?: { averageRating: number | null; totalReviewCount: number | null };
  /**
   * Every reply call that reached the fake, in order — failed ones too. How
   * tests prove a reply is posted exactly once, and that nothing but an
   * explicit human submit or the (kill-switched) auto-reply engine posts one.
   */
  calls?: Array<{ op: "putReply" | "deleteReply"; reviewName: string }>;
  /**
   * Insights per location name and metric: the value on a day is
   * `pattern[dayNumber % pattern.length]`, dayNumber = whole days since
   * 1970-01-01 UTC. A metric not listed uses {@link fakeDailyValue}'s default.
   */
  insights?: Record<string, Partial<Record<GbpDailyMetric, number[]>>>;
}

/** Days since 1970-01-01 UTC for a `YYYY-MM-DD` date. */
export function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/**
 * One day of one metric on the fake: the scenario's pattern, else a small
 * deterministic default that differs per location — and no bookings, so the
 * Insights tab's "only when non-zero" tile has a zero case by default.
 */
export function fakeDailyValue(scenario: FakeScenario, locationName: string, metric: GbpDailyMetric, date: string): number {
  const day = dayNumber(date);
  const pattern = scenario.insights?.[locationName]?.[metric];
  if (pattern && pattern.length > 0) return pattern[day % pattern.length];
  if (metric === "BUSINESS_BOOKINGS") return 0;
  let seed = 0;
  for (const ch of `${locationName}|${metric}`) seed = (seed * 31 + ch.charCodeAt(0)) % 997;
  return (seed + day) % 9 + (metric.startsWith("BUSINESS_IMPRESSIONS") ? 20 : 1);
}

export interface FakeScenarioStore {
  get(subAccountId: string): Promise<FakeScenario | null>;
  set(subAccountId: string, scenario: FakeScenario): Promise<void>;
}

/** Locked path: default-deny rules already cover `private/*`. */
export function fakeScenarioPath(subAccountId: string): string {
  return `subAccounts/${subAccountId}/private/gbpFakeScenario`;
}

/** Used by the running app (local browser proof + the CI Playwright job). */
export class FirestoreScenarioStore implements FakeScenarioStore {
  async get(subAccountId: string): Promise<FakeScenario | null> {
    const snap = await getAdminDb().doc(fakeScenarioPath(subAccountId)).get();
    return snap.exists ? (snap.data() as FakeScenario) : null;
  }

  async set(subAccountId: string, scenario: FakeScenario): Promise<void> {
    await getAdminDb().doc(fakeScenarioPath(subAccountId)).set(scenario);
  }
}

/** Used by unit tests. */
export class InMemoryScenarioStore implements FakeScenarioStore {
  private readonly data = new Map<string, FakeScenario>();

  async get(subAccountId: string): Promise<FakeScenario | null> {
    const s = this.data.get(subAccountId);
    return s ? structuredClone(s) : null;
  }

  async set(subAccountId: string, scenario: FakeScenario): Promise<void> {
    this.data.set(subAccountId, structuredClone(scenario));
  }
}

const ACCOUNT = "accounts/e2e-fixture-group";
const LOC_A = "locations/e2e-velo-gqeberha";
const LOC_B = "locations/e2e-velo-gqeberha-north";

function review(
  id: string,
  starRating: GbpReview["starRating"],
  comment: string | null,
  day: number,
  opts: { reviewer?: string; anonymous?: boolean; reply?: string } = {},
): GbpReview {
  const time = `2026-08-${String(day).padStart(2, "0")}T09:00:00Z`;
  return {
    name: `${ACCOUNT}/${LOC_A}/reviews/${id}`,
    reviewId: id,
    reviewer: {
      displayName: opts.anonymous ? "" : (opts.reviewer ?? `Fixture Reviewer ${id}`),
      profilePhotoUrl: null,
      isAnonymous: !!opts.anonymous,
    },
    starRating,
    comment,
    createTime: time,
    updateTime: time,
    reply: opts.reply
      ? { comment: opts.reply, updateTime: `2026-08-${String(day).padStart(2, "0")}T12:00:00Z` }
      : null,
  };
}

/**
 * ONE account, TWO similarly named locations (so the picker must show enough
 * to tell them apart), seven reviews on the first — newest first, as Google
 * orders by `updateTime desc`.
 */
export function defaultFakeScenario(): FakeScenario {
  return {
    accounts: [{ name: ACCOUNT, accountName: "E2E Fixture Group", type: "LOCATION_GROUP" }],
    locations: {
      [ACCOUNT]: [
        {
          name: LOC_A,
          title: "Velo Test Fibre — Gqeberha",
          address: "1 Fixture Road, Gqeberha, 6001",
          websiteUri: "https://gqeberha.fixture.example",
          placeId: "fake-place-gqeberha",
          mapsUri: "https://maps.fixture.example/?cid=fake-gqeberha",
          newReviewUri: "https://review.fixture.example/fake-gqeberha",
        },
        {
          name: LOC_B,
          title: "Velo Test Fibre — Gqeberha North",
          address: "9 Fixture Avenue, Gqeberha North, 6100",
          websiteUri: "https://north.fixture.example",
          placeId: "fake-place-gqeberha-north",
          mapsUri: "https://maps.fixture.example/?cid=fake-gqeberha-north",
          newReviewUri: "https://review.fixture.example/fake-gqeberha-north",
        },
      ],
    },
    reviews: {
      [LOC_A]: {
        averageRating: 3.6,
        totalReviewCount: 7,
        reviews: [
          review("fake-r7", 5, "Fixture review: installed on the day promised.", 27, { reply: "Thank you from the fixture team." }),
          review("fake-r6", 2, "Fixture review: technician arrived late.", 24),
          review(
            "fake-r5",
            3,
            "(Translated by Google) Fixture review: the connection is okay.\n\n(Original)\nFixture-resensie: die verbinding is okay.",
            21,
          ),
          review("fake-r4", 5, "Fixture review: fast and friendly.", 18, { anonymous: true }),
          review("fake-r3", 4, null, 15, { reply: "Thanks for the stars, fixture reviewer." }),
          review("fake-r2", 1, "Fixture review: no signal for a week. Not happy.", 12),
          review("fake-r1", 5, "  Fixture review with leading and trailing spaces.  ", 9),
        ],
      },
    },
  };
}
