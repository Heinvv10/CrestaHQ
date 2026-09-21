import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PATCH /api/agency/sub-accounts/[id]/feature-gates — the Google Business
 * gate. Characterization of the existing behaviour first (owner-only, the
 * flag written), then the one change: switching the gate OFF deletes the
 * synced review cache at once (Google's 30-day rule must not depend on a
 * sweep reaching a gate-off tenant). Real tenancy, real gate service,
 * in-memory Firestore.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { SA, claims, mem, resetSync, reviews, summaryOf, syncState } from "@/test/gbp-sync-harness";
import { syncListing } from "@/lib/gbp/sync/run";
import { PATCH } from "./route";

const ORIGINAL = { ...process.env };

async function patch(body: Record<string, unknown>, uid = "uid_owner") {
  const res = await PATCH(
    new Request(`http://127.0.0.1:3100/api/agency/sub-accounts/${SA}/feature-gates`, {
      method: "PATCH",
      headers: { "x-user-uid": uid, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: SA }) },
  );
  return res.status;
}

const gate = () => mem.read(`subAccounts/${SA}`)?.googleEnabledByAgency;

beforeEach(async () => {
  resetSync();
  claims.set("uid_owner", { status: "active", agencyId: "ag_1", agencyRole: "owner" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" });
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("characterization", () => {
  it("only the agency owner may change the gate", async () => {
    expect(await patch({ googleEnabled: false }, "uid_admin")).toBe(403);
    expect(gate()).toBe(true);
  });

  it("writes googleEnabledByAgency both ways", async () => {
    expect(await patch({ googleEnabled: false })).toBe(200);
    expect(gate()).toBe(false);
    expect(await patch({ googleEnabled: true })).toBe(200);
    expect(gate()).toBe(true);
  });

  it("another gate leaves the Google Business cache alone", async () => {
    expect(await patch({ webinar1Enabled: false })).toBe(200);
    expect(reviews()).toHaveLength(7);
  });
});

describe("switching the gate off", () => {
  it("deletes the synced reviews, the summary and the sync state at once", async () => {
    expect(await patch({ googleEnabled: false })).toBe(200);
    expect(reviews()).toHaveLength(0);
    expect(summaryOf()).toBeNull();
    expect(syncState()).toBeUndefined();
    // The connection and the listing are kept (re-enabling resumes).
    expect(mem.read(`subAccounts/${SA}`)?.googleListing).toBeTruthy();
    expect(mem.read(`subAccounts/${SA}/private/googleConnection`)).toBeTruthy();
  });

  it("a failing cache clear does not fail the gate write; the retention sweep is the backstop", async () => {
    const { storeDb } = await import("@/test/gbp-sync-store");
    vi.spyOn(storeDb, "batch").mockImplementationOnce(() => {
      throw new Error("14 UNAVAILABLE");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await patch({ googleEnabled: false })).toBe(200);
    expect(gate()).toBe(false);
    const logged = errors.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("[feature-gates] GBP cache clear failed");
    expect(logged).not.toContain("UNAVAILABLE"); // the kind, never the message
  });

  it("switching it ON keeps the cache", async () => {
    expect(await patch({ googleEnabled: true })).toBe(200);
    expect(reviews()).toHaveLength(7);
  });
});

describe("the Workspace Assistant path (set_feature_gate) hits the same chokepoint", () => {
  const ctx = { uid: "uid_owner", email: "", displayName: "Owner", agencyId: "ag_1" };
  let getCapability: typeof import("@/lib/ai-suite/capabilities").getCapability;

  // The capabilities module is ~4,200 lines. Imported inside the first test, its
  // load alone outran vitest's 5 s test timeout whenever the box was busy, and
  // the next test then ran against a half-finished one. Load it once, with room.
  beforeAll(async () => {
    ({ getCapability } = await import("@/lib/ai-suite/capabilities"));
  }, 60_000);

  it("disabling Google via the assistant deletes the review cache too", async () => {
    const cap = getCapability("set_feature_gate")!;
    await cap.execute(ctx, { subAccountId: SA, subAccountName: "Fixture", gate: "google", enabled: false });
    expect(gate()).toBe(false);
    expect(reviews()).toHaveLength(0);
    expect(summaryOf()).toBeNull();
    expect(syncState()).toBeUndefined();
  });

  it("enabling it keeps the cache, and another gate leaves it alone", async () => {
    const cap = getCapability("set_feature_gate")!;
    await cap.execute(ctx, { subAccountId: SA, subAccountName: "Fixture", gate: "google", enabled: true });
    await cap.execute(ctx, { subAccountId: SA, subAccountName: "Fixture", gate: "webinars", enabled: false });
    expect(mem.read(`subAccounts/${SA}`)?.webinar1EnabledByAgency).toBe(false);
    expect(reviews()).toHaveLength(7);
  });

  it("still refuses a sub-account of another agency (tenant anchor kept)", async () => {
    const cap = getCapability("set_feature_gate")!;
    await expect(
      cap.execute({ ...ctx, agencyId: "ag_other" }, { subAccountId: SA, gate: "google", enabled: false }),
    ).rejects.toThrow("wasn't found");
    expect(reviews()).toHaveLength(7);
  });
});
