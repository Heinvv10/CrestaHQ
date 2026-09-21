import { expect, test } from "@playwright/test";
import { ACCOUNT, defaultScenario, gbpLifecycle, pageFetch, primaryId, primaryRef, setScenario, type Scenario } from "../lib/gbp";

/**
 * SP5 G2–G4 — Reputation → Insights on the fixture PRIMARY, through the fenced
 * fake provider (live Google is blocked: case 4-6894000042302, quota 0). The
 * scenario gives each location a daily pattern per metric; the tiles must
 * equal the totals computed HERE from those patterns. Switching to the
 * second fixture location shows its own numbers and leaves the review
 * listing untouched in Firestore; a location the connection cannot see is
 * refused; and Google's quota-0 refusal reads as "not approved".
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs GBP_PROVIDER=fake, which a deployed target refuses by design");

gbpLifecycle(test);

const LOC_A = "locations/e2e-velo-gqeberha";
const LOC_B = "locations/e2e-velo-gqeberha-north";
const DAY = 86_400_000;
type Patterns = Record<string, number[]>;
const PATTERNS: Record<string, Patterns> = {
  [LOC_A]: {
    BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: [40, 55, 61], BUSINESS_IMPRESSIONS_MOBILE_SEARCH: [120, 90], BUSINESS_IMPRESSIONS_DESKTOP_MAPS: [7],
    BUSINESS_IMPRESSIONS_MOBILE_MAPS: [22, 18, 30, 25], CALL_CLICKS: [2, 0, 1], WEBSITE_CLICKS: [3, 4], BUSINESS_DIRECTION_REQUESTS: [1, 0],
    BUSINESS_CONVERSATIONS: [0], BUSINESS_BOOKINGS: [0],
  },
  [LOC_B]: {
    BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: [5], BUSINESS_IMPRESSIONS_MOBILE_SEARCH: [9, 11], BUSINESS_IMPRESSIONS_DESKTOP_MAPS: [2],
    BUSINESS_IMPRESSIONS_MOBILE_MAPS: [3], CALL_CLICKS: [1], WEBSITE_CLICKS: [0, 1], BUSINESS_DIRECTION_REQUESTS: [4],
    BUSINESS_CONVERSATIONS: [0], BUSINESS_BOOKINGS: [0],
  },
};

function scenario(extra: Record<string, unknown> = {}): Scenario {
  const s = defaultScenario();
  s.locations[ACCOUNT].push({
    name: LOC_B, title: "Velo Test Fibre — Gqeberha North", address: "9 Fixture Avenue, Gqeberha North, 6100",
    websiteUri: null, placeId: "fake-place-gqeberha-north", mapsUri: null, newReviewUri: null,
  });
  return { ...s, insights: PATTERNS, ...extra } as Scenario;
}

/** The current 28-day window's day numbers: the 28 whole UTC days ending yesterday. */
function windowDays(): number[] {
  const end = Math.floor(Date.now() / DAY) - 1;
  return Array.from({ length: 28 }, (_, i) => end - 27 + i);
}
const total = (loc: string, metrics: string[]) =>
  windowDays().reduce((sum, n) => sum + metrics.reduce((t, m) => t + PATTERNS[loc][m][n % PATTERNS[loc][m].length], 0), 0);
const tiles = (loc: string) => ({
  searchViews: total(loc, ["BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", "BUSINESS_IMPRESSIONS_MOBILE_SEARCH"]),
  mapsViews: total(loc, ["BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "BUSINESS_IMPRESSIONS_MOBILE_MAPS"]),
  calls: total(loc, ["CALL_CLICKS"]),
  websiteClicks: total(loc, ["WEBSITE_CLICKS"]),
  directions: total(loc, ["BUSINESS_DIRECTION_REQUESTS"]),
});
const fmt = (n: number) => n.toLocaleString("en-US");

test("insights: the listing's numbers, another location's numbers, the listing untouched, not-approved worded", async ({ page }) => {
  await setScenario(scenario());
  const listingBefore = (await primaryRef().get()).data()?.googleListing as Record<string, unknown>;
  expect(listingBefore.locationName).toBe(LOC_A);

  await page.goto(`/sa/${primaryId()}/reputation/insights`);
  await expect(page.getByTestId("rep-tab-insights")).toHaveAttribute("aria-current", "page", { timeout: 30_000 });
  const a = tiles(LOC_A);
  for (const [key, value] of Object.entries(a)) {
    await expect(page.getByTestId(`rep-insights-tile-${key}-value`), key).toHaveText(fmt(value), { timeout: 30_000 });
  }
  // Conversations and bookings are zero in both periods: no tiles.
  await expect(page.getByTestId("rep-insights-tile-conversations")).toHaveCount(0);
  await expect(page.getByTestId("rep-insights-chart-views")).toBeVisible();

  // --- Another location this connection can see.
  const location = page.getByTestId("rep-insights-location");
  await expect(location.locator("option")).toHaveCount(2);
  await location.selectOption(LOC_B);
  const b = tiles(LOC_B);
  expect(b.searchViews).not.toBe(a.searchViews);
  for (const [key, value] of Object.entries(b)) {
    await expect(page.getByTestId(`rep-insights-tile-${key}-value`), key).toHaveText(fmt(value), { timeout: 30_000 });
  }
  await expect(page.getByTestId("rep-insights-other-location")).toContainText("Velo Test Fibre — Gqeberha North");
  // Viewing it changed nothing about the review listing.
  expect((await primaryRef().get()).data()?.googleListing).toEqual(listingBefore);

  // --- A location the connection cannot see is refused by the server, whatever the client sends.
  const refused = await pageFetch(page, `/api/sub-accounts/${primaryId()}/reputation/insights?location=${encodeURIComponent("locations/not-visible-here")}`, "GET");
  expect(refused.status).toBe(400);
  expect(refused.body.code).toBe("unknown_location");

  // --- Google's quota-0 refusal (a range not yet memoised, so the call reaches the fake).
  await setScenario(scenario({ failNext: { op: "fetchDailyMetrics", kind: "access_not_approved" } }));
  await page.getByTestId("rep-insights-range").selectOption("7d");
  await expect(page.getByTestId("rep-insights-not-approved")).toHaveText(
    "Google hasn't approved Business Profile API access for this project yet.",
    { timeout: 30_000 },
  );
  expect((await primaryRef().get()).data()?.googleListing).toEqual(listingBefore);
});
