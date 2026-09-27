import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/google-oauth-harness")).adminMock());
vi.mock("firebase-admin/firestore", async () => (await import("@/test/google-oauth-harness")).firestoreMock());

import { SUB, SUB_PATH, resetHarness, state } from "@/test/google-oauth-harness";
import { LOC_NORTH, enableFakeMode, seedConnection } from "@/test/gbp-route-harness";
import { LOC_C, pair, putExtras, seedMainAndScenario, subDoc } from "@/test/extra-listings-harness";
import { clearListing } from "@/lib/gbp/listing-events";
import { locId } from "@/lib/gbp/listings";

const MAIN_URL = "https://g.page/r/main/review";
const withUrls = (urls: Record<string, string>) =>
  state.docs.set(SUB_PATH, { ...subDoc(), googleReviewConfig: { enabled: true, reviewUrl: MAIN_URL, listingUrls: urls } });
const config = () => subDoc().googleReviewConfig as { reviewUrl?: string; listingUrls?: Record<string, string> };

beforeEach(() => {
  resetHarness();
  enableFakeMode();
  seedConnection();
  seedMainAndScenario();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("removing an extra drops only its adopted review link; the main's and other extras' stay", async () => {
  expect((await putExtras({ listings: [pair(LOC_NORTH), pair(LOC_C)] })).status).toBe(200);
  withUrls({ [locId(LOC_NORTH)]: "https://g.page/r/north/review", [locId(LOC_C)]: "https://g.page/r/c/review" });
  expect((await putExtras({ listings: [pair(LOC_C)] })).status).toBe(200);
  expect(config().reviewUrl).toBe(MAIN_URL);
  expect(config().listingUrls).toEqual({ [locId(LOC_C)]: "https://g.page/r/c/review" });
});

it("clearing the main (disconnect) drops every extra's link but keeps the main's", async () => {
  expect((await putExtras({ listings: [pair(LOC_NORTH)] })).status).toBe(200);
  withUrls({ [locId(LOC_NORTH)]: "https://g.page/r/north/review" });
  await clearListing(SUB, "uid_admin", "disconnected");
  expect(config().reviewUrl).toBe(MAIN_URL);
  expect(config().listingUrls).toBeUndefined();
});
