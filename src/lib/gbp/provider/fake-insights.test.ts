import { describe, expect, it } from "vitest";

import { createFakeGbpProvider } from "./fake";
import { InMemoryScenarioStore, defaultFakeScenario } from "./fake-scenario";
import { GBP_DAILY_METRICS, GbpProviderError } from "./types";

/**
 * The fake's fetchDailyMetrics: deterministic per location, overridable from
 * the scenario, bound to its sub-account like every fake op, and failing on
 * demand with any provider kind (incl. access_not_approved).
 */

const SA = "sa_fake";
const LOC_A = "locations/e2e-velo-gqeberha";
const LOC_B = "locations/e2e-velo-gqeberha-north";
const RANGE = { metrics: [...GBP_DAILY_METRICS], startDate: "2026-08-28", endDate: "2026-09-03" };

async function connected() {
  const store = new InMemoryScenarioStore();
  const fake = createFakeGbpProvider(store, SA);
  const { accessToken } = await fake.exchangeCode(`fake-code:${SA}`, "http://127.0.0.1:3100/cb");
  return { store, fake, accessToken };
}
async function kindOf(p: Promise<unknown>) {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(GbpProviderError);
  return (e as GbpProviderError).kind;
}
const total = (s: Array<{ value: number }> | undefined) => (s ?? []).reduce((n, d) => n + d.value, 0);

describe("fetchDailyMetrics (fake)", () => {
  it("returns one value per day, for exactly the requested metrics and range, deterministically", async () => {
    const { fake, accessToken } = await connected();
    const a = await fake.fetchDailyMetrics(accessToken, LOC_A, RANGE);
    expect(Object.keys(a).sort()).toEqual([...GBP_DAILY_METRICS].sort());
    expect(a.CALL_CLICKS!.map((d) => d.date)).toEqual(["2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(await fake.fetchDailyMetrics(accessToken, LOC_A, RANGE)).toEqual(a);
    const only = await fake.fetchDailyMetrics(accessToken, LOC_A, { ...RANGE, metrics: ["WEBSITE_CLICKS"] });
    expect(Object.keys(only)).toEqual(["WEBSITE_CLICKS"]);
    expect(only.WEBSITE_CLICKS).toEqual(a.WEBSITE_CLICKS);
  });

  it("differs between the two fixture locations, and has no bookings by default", async () => {
    const { fake, accessToken } = await connected();
    const a = await fake.fetchDailyMetrics(accessToken, LOC_A, RANGE);
    const b = await fake.fetchDailyMetrics(accessToken, LOC_B, RANGE);
    expect(total(a.BUSINESS_IMPRESSIONS_MOBILE_SEARCH)).not.toBe(total(b.BUSINESS_IMPRESSIONS_MOBILE_SEARCH));
    expect(total(a.BUSINESS_BOOKINGS)).toBe(0);
    expect(total(a.CALL_CLICKS)).toBeGreaterThan(0);
  });

  it("follows a scenario override: pattern[dayNumber % length], dayNumber = days since 1970-01-01", async () => {
    const { store, fake, accessToken } = await connected();
    const s = (await store.get(SA)) ?? defaultFakeScenario();
    s.insights = { [LOC_A]: { CALL_CLICKS: [1, 2, 3] } };
    await store.set(SA, s);
    const got = await fake.fetchDailyMetrics(accessToken, LOC_A, { ...RANGE, metrics: ["CALL_CLICKS"] });
    // 2026-08-28 is day 20693 (Date.UTC(2026, 7, 28) / 86_400_000).
    const expected = [20693, 20694, 20695, 20696, 20697, 20698, 20699].map((n) => [1, 2, 3][n % 3]);
    expect(got.CALL_CLICKS!.map((d) => d.value)).toEqual(expected);
  });

  it("refuses a location no account in the scenario has", async () => {
    const { fake, accessToken } = await connected();
    expect(await kindOf(fake.fetchDailyMetrics(accessToken, "locations/somebody-else", RANGE))).toBe("not_found");
  });

  it("fails once on demand with the scripted kind", async () => {
    const { store, fake, accessToken } = await connected();
    const s = (await store.get(SA)) ?? defaultFakeScenario();
    s.failNext = { op: "fetchDailyMetrics", kind: "access_not_approved" };
    await store.set(SA, s);
    expect(await kindOf(fake.fetchDailyMetrics(accessToken, LOC_A, RANGE))).toBe("access_not_approved");
    await expect(fake.fetchDailyMetrics(accessToken, LOC_A, RANGE)).resolves.toBeTruthy();
  });

  it("refuses another sub-account's token, like every fake op", async () => {
    const { fake } = await connected();
    expect(await kindOf(fake.fetchDailyMetrics("fake-access:sa_other:1", LOC_A, RANGE))).toBe("auth_expired");
  });
});
