import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PUT /api/sub-accounts/[id]/google/extra-listings — who may call it and
 * everything it refuses. Through the real route: real tenancy guard, real
 * fake provider, Firestore faked underneath.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/google-oauth-harness")).adminMock());
vi.mock("firebase-admin/firestore", async () => (await import("@/test/google-oauth-harness")).firestoreMock());

import { OTHER_SUB, SUB_PATH, resetHarness, state } from "@/test/google-oauth-harness";
import { DEFAULT_ACCOUNT, LOC_A, LOC_NORTH, enableFakeMode, seedConnection, setScenario } from "@/test/gbp-route-harness";
import { LOC_C, pair, putExtras, seedMainAndScenario, subDoc } from "@/test/extra-listings-harness";

const ORIGINAL = { ...process.env };
const OTHER_PATH = `subAccounts/${OTHER_SUB}`;

beforeEach(() => {
  resetHarness();
  enableFakeMode();
  seedConnection();
  seedMainAndScenario();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

/** A refusal writes nothing at all. */
async function refused(body: unknown, status: number, code: string, uid?: string) {
  const res = await putExtras(body, uid);
  expect([res.status, res.body.code]).toEqual([status, code]);
  expect(state.writes).toEqual([]);
}

describe("authorization and gate", () => {
  it.each([
    ["a non-member", "uid_other_admin"],
    ["a collaborator", "uid_collab"],
    ["a plain member", "uid_member"],
  ])("refuses %s with 403 and writes nothing", async (_l, uid) => {
    const res = await putExtras({ listings: [pair(LOC_NORTH)] }, uid);
    expect(res.status).toBe(403);
    expect(state.writes).toEqual([]);
  });

  it("refuses gate_off when the agency gate is off", async () => {
    state.docs.set(SUB_PATH, { ...subDoc(), googleEnabledByAgency: false });
    await refused({ listings: [pair(LOC_NORTH)] }, 403, "gate_off");
  });

  it("refuses not_connected without a connection", async () => {
    state.docs.set(SUB_PATH, { ...subDoc(), googleConnectionMeta: null });
    await refused({ listings: [pair(LOC_NORTH)] }, 409, "not_connected");
  });
});

describe("body", () => {
  it.each([
    ["not JSON", "not json"],
    ["no listings", {}],
    ["listings not a list", { listings: pair(LOC_NORTH) }],
    ["a bad account name", { listings: [pair(LOC_NORTH, "x")] }],
    ["a bad location name", { listings: [pair(`${DEFAULT_ACCOUNT}/${LOC_NORTH}`)] }],
    ["a null entry", { listings: [null] }],
    ["the same location twice", { listings: [pair(LOC_NORTH), pair(LOC_NORTH)] }],
  ])("refuses %s as invalid_body", async (_l, body) => {
    await refused(body, 400, "invalid_body");
  });

  it("refuses more than MAX_EXTRA_LISTINGS (9) as too_many", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => pair(`locations/l${i}`));
    await refused({ listings: ten }, 400, "too_many");
  });

  it("refuses a body over 8 KB with 413", async () => {
    await refused(JSON.stringify({ listings: [], pad: "x".repeat(9000) }), 413, "body_too_large");
  });
});

describe("refusals", () => {
  it("is_main: the main listing cannot also be an extra", async () => {
    await refused({ listings: [pair(LOC_NORTH), pair(LOC_A)] }, 400, "is_main");
  });

  it("no_listing: extras need a main listing", async () => {
    state.docs.set(SUB_PATH, { ...subDoc(), googleListing: null });
    await refused({ listings: [pair(LOC_NORTH)] }, 409, "no_listing");
  });

  it("unknown_location: a location this connection cannot see", async () => {
    await refused({ listings: [pair(LOC_NORTH), pair("locations/someone-elses")] }, 400, "unknown_location");
  });

  it("unknown_location: a real location paired with the wrong account", async () => {
    setScenario((s) => {
      s.accounts.push({ name: "accounts/other", accountName: "Other", type: "PERSONAL" });
      s.locations["accounts/other"] = [];
    });
    await refused({ listings: [pair(LOC_NORTH, "accounts/other")] }, 400, "unknown_location");
  });

  it("unverifiable_truncated: the walk stopped before finding it", async () => {
    setScenario((s) => {
      for (let i = 0; i < 70; i++) s.accounts.unshift({ name: `accounts/filler-${i}`, accountName: `F${i}`, type: "PERSONAL" });
    });
    await refused({ listings: [pair(LOC_NORTH)] }, 400, "unverifiable_truncated");
  });

  it("listing_shared: another sub-account holds it as an EXTRA", async () => {
    state.docs.set(OTHER_PATH, {
      agencyId: "ag_1",
      googleListing: { locationName: "locations/other-main" },
      googleExtraListings: [{ locationName: LOC_NORTH }],
      googleLocationNames: ["locations/other-main", LOC_NORTH],
    });
    await refused({ listings: [pair(LOC_C), pair(LOC_NORTH)] }, 409, "listing_shared");
  });

  it("listing_shared: another sub-account holds it as its MAIN (a legacy doc without the flat array)", async () => {
    state.docs.set(OTHER_PATH, { agencyId: "ag_1", googleListing: { locationName: LOC_NORTH } });
    await refused({ listings: [pair(LOC_NORTH)] }, 409, "listing_shared");
  });

  it("a stale flat array alone does not refuse", async () => {
    state.docs.set(OTHER_PATH, { agencyId: "ag_1", googleListing: null, googleLocationNames: [LOC_NORTH] });
    expect((await putExtras({ listings: [pair(LOC_NORTH)] })).status).toBe(200);
  });

  it("a Google failure maps to the shared error body and writes nothing", async () => {
    setScenario((s) => (s.failNext = { op: "listAccounts", kind: "transient" }));
    const res = await putExtras({ listings: [pair(LOC_NORTH)] });
    expect([res.status, res.body.code]).toEqual([424, "transient"]);
    // The fake consumed its scripted failure (its own doc); nothing else was written.
    expect(state.writes.map((w) => w.path)).toEqual([`${SUB_PATH}/private/gbpFakeScenario`]);
  });
});

describe("single listing: unchanged", () => {
  it("an empty set on a sub-account without extras writes nothing and calls no one", async () => {
    setScenario((s) => (s.failNext = { op: "listAccounts", kind: "transient" }));
    const res = await putExtras({ listings: [] });
    expect(res).toEqual({ status: 200, body: { ok: true, added: [], removed: [] } });
    expect(state.writes).toEqual([]);
  });
});
