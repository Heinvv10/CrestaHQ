import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { LOC_A, LOC_NORTH, NOW, SA, mem, recordingSleep, resetSync, reviews, seedExtraListing } from "@/test/gbp-sync-harness";
import { buildFeed } from "../feed/build";
import { locId } from "../listings";
import { syncSubAccount } from "./sub-account";
import { runGbpRetentionSweep } from "./sweep";

const HOUR = 3600_000;
const sleep = recordingSleep().sleep;
const sub = () => mem.read(`subAccounts/${SA}`)!;

beforeEach(() => {
  resetSync();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("the public widget reads only its own listing", () => {
  it("a busy extra listing never crowds the main listing out of its website widget", async () => {
    seedExtraListing(SA);
    await syncSubAccount(SA, { trigger: "scheduled", now: NOW, sleep });
    // The extra listing has 200 reviews newer than the main's (as its sync would store them).
    for (let i = 0; i < 200; i++) {
      mem.seed(`subAccounts/${SA}/gbpReviews/north-busy-${i}`, {
        locationName: LOC_NORTH, state: "active", reviewName: `x/${LOC_NORTH}/reviews/b${i}`, starRating: 5,
        comment: "busy", createTime: new Date(NOW.getTime() - (i + 1) * 60_000), lastSeenAt: NOW,
      });
    }
    expect(reviews().filter((r) => r.locationName === LOC_A && r.state === "active")).toHaveLength(7);
    const widget = { subAccountId: SA, agencyId: "ag_1", enabled: true, maxReviews: 5, allowedOrigins: [], createdByUid: "uid_admin", createdAt: NOW, updatedAt: NOW };
    const feed = await buildFeed({ publicId: "w_brk", widget: widget as never, sub: sub() as never }, new Date(NOW.getTime() + HOUR));
    expect(feed.status).toBe("ok");
    expect(feed.reviews).toHaveLength(5);
  });
});

describe("retention ignores a summary left for a listing no longer connected", () => {
  it("gate off, main cache empty, a non-current extra's summary left by a clear that died", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await syncSubAccount(SA, { trigger: "scheduled", now: NOW, sleep });
    // A removed extra whose clear died after its deletes, before its summary patch.
    const s = sub();
    mem.seed(`subAccounts/${SA}`, {
      ...s, googleEnabledByAgency: false,
      gbpSummaries: { [locId("locations/gone")]: { ...(s.gbpSummary as object), locationName: "locations/gone" } },
    });
    for (const d of [31, 32, 60]) { vi.setSystemTime(new Date(NOW.getTime() + d * 24 * HOUR)); await runGbpRetentionSweep(); }
    expect(reviews().length).toBe(0);
    expect(sub().gbpSummary).toBeNull();
  });
});
