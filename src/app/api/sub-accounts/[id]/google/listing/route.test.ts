import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PUT/DELETE /api/sub-accounts/[id]/google/listing — choosing which Business
 * Profile location this sub-account manages. The server re-fetches the pair
 * through the provider; nothing the client sends beyond the two resource
 * names is trusted.
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/google-oauth-harness")).adminMock(),
);
vi.mock("firebase-admin/firestore", async () =>
  (await import("@/test/google-oauth-harness")).firestoreMock(),
);

import { SUB, SUB_PATH, request, resetHarness, state } from "@/test/google-oauth-harness";
import {
  DEFAULT_ACCOUNT,
  LOC_A,
  LOC_NORTH,
  TOKEN_MARKERS,
  enableFakeMode,
  seedConnection,
  setScenario,
} from "@/test/gbp-route-harness";
import { DELETE, PUT } from "./route";

const ORIGINAL = { ...process.env };
const URL_ = `http://127.0.0.1:3100/api/sub-accounts/${SUB}/google/listing`;

async function put(body: unknown, uid = "uid_admin") {
  const req = new Request(URL_, {
    method: "PUT",
    headers: { "x-user-uid": uid, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const res = await PUT(req, { params: Promise.resolve({ id: SUB }) });
  const text = await res.text();
  expect(text).not.toMatch(TOKEN_MARKERS);
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
}

async function del(uid = "uid_admin") {
  const res = await DELETE(request(URL_, uid, "DELETE"), { params: Promise.resolve({ id: SUB }) });
  const text = await res.text();
  expect(text).not.toMatch(TOKEN_MARKERS);
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
}

const events = () =>
  [...state.docs.entries()].filter(([p]) => p.startsWith(`${SUB_PATH}/gbpEvents/`)).map(([, d]) => d);
const listing = () => state.docs.get(SUB_PATH)?.googleListing as Record<string, unknown> | null | undefined;

beforeEach(() => {
  resetHarness();
  enableFakeMode();
  seedConnection();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("PUT authorization", () => {
  it.each([
    ["a non-member", "uid_other_admin"],
    ["a collaborator", "uid_collab"],
  ])("refuses %s and writes nothing", async (_l, uid) => {
    expect((await put({ accountName: DEFAULT_ACCOUNT, locationName: LOC_NORTH }, uid)).status).toBe(403);
    expect(state.writes).toEqual([]);
  });

  it("refuses with gate_off when the agency gate is off", async () => {
    state.docs.set(SUB_PATH, { ...state.docs.get(SUB_PATH), googleEnabledByAgency: false });
    const { status, body } = await put({ accountName: DEFAULT_ACCOUNT, locationName: LOC_NORTH });
    expect([status, body.code]).toEqual([403, "gate_off"]);
    expect(state.writes).toEqual([]);
  });
});

describe("PUT validation", () => {
  it("rejects a malformed body", async () => {
    for (const body of [
      "not json",
      {},
      { accountName: DEFAULT_ACCOUNT },
      { accountName: "x", locationName: LOC_A },
      // A v4 review-parent path is not a Business Information location name.
      { accountName: DEFAULT_ACCOUNT, locationName: `${DEFAULT_ACCOUNT}/${LOC_A}` },
    ]) {
      const res = await put(body);
      expect([res.status, res.body.code]).toEqual([400, "invalid_body"]);
    }
    expect(state.writes).toEqual([]);
  });

  it("refuses a location this connection cannot see", async () => {
    const res = await put({ accountName: DEFAULT_ACCOUNT, locationName: "locations/someone-elses" });
    expect([res.status, res.body.code]).toEqual([400, "unknown_location"]);
    expect(state.writes).toEqual([]);
  });

  it("refuses an account this connection cannot see", async () => {
    const res = await put({ accountName: "accounts/not-visible", locationName: LOC_NORTH });
    expect([res.status, res.body.code]).toEqual([400, "unknown_location"]);
    expect(state.writes).toEqual([]);
  });

  it("refuses a pair it cannot verify because the walk was truncated", async () => {
    setScenario((s) => {
      for (let i = 0; i < 70; i++) s.accounts.unshift({ name: `accounts/filler-${i}`, accountName: `F${i}`, type: "PERSONAL" });
    });
    const res = await put({ accountName: DEFAULT_ACCOUNT, locationName: LOC_NORTH });
    expect([res.status, res.body.code]).toEqual([400, "unknown_location"]);
    expect(state.writes).toEqual([]);
  });

  it("refuses a real location paired with the wrong account", async () => {
    setScenario((s) => {
      s.accounts.push({ name: "accounts/other", accountName: "Other", type: "PERSONAL" });
      s.locations["accounts/other"] = [];
    });
    const res = await put({ accountName: "accounts/other", locationName: LOC_NORTH });
    expect([res.status, res.body.code]).toEqual([400, "unknown_location"]);
    expect(listing()).toBeUndefined();
  });
});

describe("PUT selection", () => {
  it("writes exactly the server-fetched listing and an audit event", async () => {
    const res = await put({
      accountName: DEFAULT_ACCOUNT,
      locationName: LOC_NORTH,
      // Client-supplied display fields are IGNORED.
      title: "Attacker Title",
      placeId: "attacker-place",
    });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(listing()).toEqual({
      accountName: DEFAULT_ACCOUNT,
      accountDisplayName: "E2E Fixture Group",
      locationName: LOC_NORTH,
      title: "Velo Test Fibre — Gqeberha North",
      address: "9 Fixture Avenue, Gqeberha North, 6100",
      websiteUri: "https://north.fixture.example",
      placeId: "fake-place-gqeberha-north",
      mapsUri: "https://maps.fixture.example/?cid=fake-gqeberha-north",
      newReviewUri: "https://review.fixture.example/fake-gqeberha-north",
      selectedAt: "SERVER_TS",
      selectedByUid: "uid_admin",
    });
    expect(events()).toEqual([
      {
        type: "listing_selected",
        agencyId: "ag_1",
        subAccountId: SUB,
        createdByUid: "uid_admin",
        at: "SERVER_TS",
        locationName: LOC_NORTH,
        previousLocationName: null,
      },
    ]);
    // Nothing but the listing (and its timestamp) changed on the member-readable doc.
    const docWrite = state.writes.find((w) => w.path === SUB_PATH);
    expect(Object.keys(docWrite?.data ?? {}).sort()).toEqual(["googleListing", "updatedAt"]);
  });

  it("takes the account display name from the account actually selected", async () => {
    setScenario((s) => {
      s.accounts.push({ name: "accounts/second", accountName: "Second Fixture Group", type: "PERSONAL" });
      s.locations["accounts/second"] = [{ ...s.locations[DEFAULT_ACCOUNT][0], name: "locations/second-loc" }];
    });
    await put({ accountName: "accounts/second", locationName: "locations/second-loc" });
    expect(listing()).toMatchObject({ accountName: "accounts/second", accountDisplayName: "Second Fixture Group" });
  });

  it("records the previous location when the listing changes", async () => {
    await put({ accountName: DEFAULT_ACCOUNT, locationName: LOC_A });
    await put({ accountName: DEFAULT_ACCOUNT, locationName: LOC_NORTH });
    expect(events().map((e) => e.previousLocationName)).toEqual([null, LOC_A]);
    expect(listing()?.locationName).toBe(LOC_NORTH);
  });

  it("reports not_connected without a connection", async () => {
    state.docs.set(SUB_PATH, { agencyId: "ag_1", googleEnabledByAgency: true });
    const res = await put({ accountName: DEFAULT_ACCOUNT, locationName: LOC_NORTH });
    expect([res.status, res.body.code]).toEqual([409, "not_connected"]);
  });
});

describe("DELETE", () => {
  beforeEach(async () => {
    await put({ accountName: DEFAULT_ACCOUNT, locationName: LOC_NORTH });
    state.writes = [];
  });

  it("clears the selection for an admin, even with the gate off", async () => {
    state.docs.set(SUB_PATH, { ...state.docs.get(SUB_PATH), googleEnabledByAgency: false });
    expect(await del()).toEqual({ status: 200, body: { ok: true } });
    expect(listing()).toBeNull();
  });

  it("audits the clear with who did it and what was cleared", async () => {
    await del();
    expect(events().filter((e) => e.type === "listing_cleared")).toEqual([
      {
        type: "listing_cleared",
        reason: "admin_cleared",
        agencyId: "ag_1",
        subAccountId: SUB,
        createdByUid: "uid_admin",
        at: "SERVER_TS",
        locationName: null,
        previousLocationName: LOC_NORTH,
      },
    ]);
  });

  it("writes no event when there was nothing to clear", async () => {
    await del();
    const before = events().length;
    await del();
    expect(events().length).toBe(before);
  });

  it.each([
    ["a non-member", "uid_other_admin"],
    ["a collaborator", "uid_collab"],
  ])("refuses %s and writes nothing", async (_l, uid) => {
    expect((await del(uid)).status).toBe(403);
    expect(state.writes).toEqual([]);
    expect(listing()?.locationName).toBe(LOC_NORTH);
  });
});
