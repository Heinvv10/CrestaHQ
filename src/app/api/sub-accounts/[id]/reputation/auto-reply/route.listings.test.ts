import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET/PUT …/reputation/auto-reply — the per-listing switch
 * (MULTI_LISTING_V1_PLAN.md PR 6): `listings: {locationName: on}` for EXTRA
 * listings, stamped per listing, `listing_shared` asked per listing, off
 * deletes the key, a listing left out keeps its state. Real tenancy and
 * gates, Firestore in memory.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { LOC_A, LOC_NORTH, OTHER_SA, SA, asUser, mem, resetSync, seedExtraListing } from "@/test/gbp-sync-harness";
import { locId } from "@/lib/gbp/listings";
import { GET, PUT } from "./route";

const MODES = { 1: "approval", 2: "approval", 3: "approval", 4: "auto", 5: "auto" };
const ON = { enabled: true, modes: MODES, includeBacklog: false };
const OFF = { ...ON, enabled: false };
const B = LOC_NORTH;
const B_KEY = locId(B);

const url = `http://127.0.0.1:3100/api/sub-accounts/${SA}/reputation/auto-reply`;
const put = async (body: unknown, uid = "uid_admin") => {
  const res = await PUT(asUser(url, uid, "PUT", JSON.stringify(body)), { params: Promise.resolve({ id: SA }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const get = async () => (await GET(asUser(url, "uid_collab"), { params: Promise.resolve({ id: SA }) })).json() as Promise<Record<string, unknown>>;
const stored = () => mem.read(`subAccounts/${SA}`)?.reviewsAutoReply as Record<string, unknown> | undefined;
const extras = () => (stored()?.extraListings ?? {}) as Record<string, { enabledAt: Date; enabledByUid: string }>;
const patchSub = (patch: Record<string, unknown>, sa = SA) => mem.seed(`subAccounts/${sa}`, { ...mem.read(`subAccounts/${sa}`)!, ...patch });

beforeEach(() => {
  resetSync();
  patchSub({ reviewsAiEnabledByAgency: true, reviewsAutoReplyEnabledByAgency: true });
  patchSub({ googleListing: { ...(mem.read(`subAccounts/${OTHER_SA}`)!.googleListing as object), locationName: "locations/elsewhere" } }, OTHER_SA);
  seedExtraListing(SA, B);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PUT listings", () => {
  it("switches B on alone: its own stamps; main stays off; GET shows one row per listing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-27T20:00:00Z"));
    const res = await put({ ...OFF, listings: { [B]: true } });
    expect(res.status).toBe(200);
    expect(stored()).toMatchObject({ enabled: false });
    expect(extras()[B_KEY].enabledByUid).toBe("uid_admin");
    expect(extras()[B_KEY].enabledAt.toISOString()).toBe("2026-09-27T20:00:00.000Z");
    const rows = [
      { locationName: LOC_A, title: "Velo Test Fibre — Gqeberha", main: true, enabled: false, enabledAt: null },
      { locationName: B, title: "Velo Test Fibre — Gqeberha North", main: false, enabled: true, enabledAt: "2026-09-27T20:00:00.000Z" },
    ];
    expect((await get()).listings).toEqual(rows);
    expect((res.body.reviewsAutoReply as Record<string, unknown>).listings).toEqual(rows);
  });

  it("on→on keeps B's original stamps; a body without listings leaves B as it is", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-27T20:00:00Z"));
    await put({ ...OFF, listings: { [B]: true } });
    vi.setSystemTime(new Date("2026-09-28T20:00:00Z"));
    expect((await put({ ...ON, listings: { [B]: true } }, "uid_admin")).status).toBe(200);
    expect(extras()[B_KEY].enabledAt.toISOString()).toBe("2026-09-27T20:00:00.000Z");
    expect((await put(ON)).status).toBe(200);
    expect(Object.keys(extras())).toEqual([B_KEY]);
  });

  it("off deletes B's key; main is untouched", async () => {
    await put({ ...ON, listings: { [B]: true } });
    expect((await put({ ...ON, listings: { [B]: false } })).status).toBe(200);
    expect(extras()).toEqual({});
    expect(stored()).toMatchObject({ enabled: true, listingLocationName: LOC_A });
  });

  it("a location that is not a connected extra is 400 unknown_listing (the main, an unknown one), nothing written", async () => {
    for (const loc of [LOC_A, "locations/not-connected"]) {
      const res = await put({ ...OFF, listings: { [loc]: true } });
      expect([res.status, res.body.code]).toEqual([400, "unknown_listing"]);
    }
    expect(stored()).toBeUndefined();
  });

  it.each([
    ["a non-boolean", { [B]: "yes" }],
    ["a malformed location", { "not-a-location": true }],
    ["an array", [B]],
    ["null", null],
  ])("refuses listings as %s with 400 invalid_body", async (_l, listings) => {
    const res = await put({ ...OFF, listings });
    expect([res.status, res.body.code]).toEqual([400, "invalid_body"]);
  });

  it("switching B on while another sub-account manages B (as an extra) is 409 listing_shared; main alone still switches on", async () => {
    patchSub({ googleExtraListings: [{ locationName: B }], googleLocationNames: ["locations/elsewhere", B] }, OTHER_SA);
    const res = await put({ ...ON, listings: { [B]: true } });
    expect([res.status, res.body.code]).toEqual([409, "listing_shared"]);
    expect(stored()).toBeUndefined();
    expect((await put(ON)).status).toBe(200);
    expect((await put({ ...ON, listings: { [B]: false } })).status).toBe(200);
  });

  it("switching B on needs the gates, like main", async () => {
    patchSub({ reviewsAutoReplyEnabledByAgency: false });
    const res = await put({ ...OFF, listings: { [B]: true } });
    expect([res.status, res.body.code]).toEqual([403, "auto_reply_gate_off"]);
    expect(stored()).toBeUndefined();
  });

  it("switching B on while a Google reconnect is pending is 409 reconnect_required", async () => {
    patchSub({ googleConnectionMeta: { ...(mem.read(`subAccounts/${SA}`)!.googleConnectionMeta as object), reconnectRequired: true } });
    const res = await put({ ...OFF, listings: { [B]: true } });
    expect([res.status, res.body.code]).toEqual([409, "reconnect_required"]);
  });
});
