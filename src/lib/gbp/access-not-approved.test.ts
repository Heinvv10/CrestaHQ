import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SP5 G4 — `access_not_approved` (Google's quota-0 429) at every seam that
 * shows a provider error: the sync never retries it and records the kind;
 * the listings route answers the fixed "not approved" sentence, never a body.
 * Real require-tenancy, fence, tokens and fake provider on the in-memory store.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { NOW, SA, asUser, recordingSleep, resetSync, runs, setScenario, summaryOf } from "@/test/gbp-sync-harness";
import { GET as LOCATIONS } from "@/app/api/sub-accounts/[id]/google/locations/route";
import { ACCESS_NOT_APPROVED_TEXT } from "./error-text";
import { GbpProviderError } from "./provider/types";
import { withRetry } from "./sync/retry";
import { syncListing } from "./sync/run";

let clock: ReturnType<typeof recordingSleep>;
beforeEach(() => {
  resetSync();
  clock = recordingSleep();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("the sync", () => {
  it("does not retry it (withRetry calls once, never sleeps)", async () => {
    let calls = 0;
    const call = withRetry(async () => {
      calls += 1;
      throw new GbpProviderError("access_not_approved", { status: 429 });
    }, clock.sleep);
    await expect(call).rejects.toMatchObject({ kind: "access_not_approved" });
    expect(calls).toBe(1);
    expect(clock.waits).toEqual([]);
  });

  it("records a failed run with errorKind access_not_approved after ONE attempt", async () => {
    setScenario(SA, (s) => void (s.failReviewsPage = { pageToken: null, kind: "access_not_approved", times: 1 }));
    const run = await syncListing(SA, { trigger: "scheduled", now: NOW, sleep: clock.sleep });
    expect(run).toMatchObject({ status: "failed", errorKind: "access_not_approved", pagesFetched: 0 });
    expect(clock.waits).toEqual([]);
    expect(runs()).toHaveLength(1);
    expect(summaryOf()).toMatchObject({ lastErrorKind: "access_not_approved" });
  });
});

describe("the listings route (the picker's data)", () => {
  it("answers 502 access_not_approved with the fixed sentence", async () => {
    setScenario(SA, (s) => void (s.failNext = { op: "listAccounts", kind: "access_not_approved" }));
    const res = await LOCATIONS(asUser(`http://127.0.0.1:3100/api/sub-accounts/${SA}/google/locations`, "uid_admin"), {
      params: Promise.resolve({ id: SA }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ code: "access_not_approved", error: ACCESS_NOT_APPROVED_TEXT });
    expect(ACCESS_NOT_APPROVED_TEXT).toBe("Google hasn't approved Business Profile API access for this project yet.");
  });

  it("any other provider kind keeps the generic sentence", async () => {
    setScenario(SA, (s) => void (s.failNext = { op: "listAccounts", kind: "rate_limited" }));
    const res = await LOCATIONS(asUser(`http://127.0.0.1:3100/api/sub-accounts/${SA}/google/locations`, "uid_admin"), {
      params: Promise.resolve({ id: SA }),
    });
    expect(await res.json()).toEqual({ code: "rate_limited", error: "Google request failed" });
  });
});
