import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET/PUT /api/sub-accounts/[id]/reputation/auto-reply — review auto-reply
 * settings (AUTO_REPLY_V1_PLAN.md, PR 1). Real tenancy and gates, Firestore
 * in memory (transactions honoured). The engine flag is overridable so the
 * 409 `not_available` refusal PR 1 shipped stays tested now PR 2 lifted it.
 */

const engine = vi.hoisted(() => ({ available: true }));
vi.mock("@/lib/reputation/auto-reply/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reputation/auto-reply/settings")>();
  return {
    ...actual,
    get AUTO_REPLY_ENGINE_AVAILABLE() {
      return engine.available;
    },
  };
});
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { LOC_A, LOC_NORTH, OTHER_SA, SA, asUser, mem, resetSync } from "@/test/gbp-sync-harness";
import { GET, PUT } from "./route";

const MODES = { 1: "approval", 2: "approval", 3: "approval", 4: "auto", 5: "auto" };
const ON = { enabled: true, modes: MODES, includeBacklog: false };
const OFF = { ...ON, enabled: false };

const url = (sa: string) => `http://127.0.0.1:3100/api/sub-accounts/${sa}/reputation/auto-reply`;
const put = async (body: unknown, uid = "uid_admin", sa = SA) => {
  const res = await PUT(asUser(url(sa), uid, "PUT", typeof body === "string" ? body : JSON.stringify(body)), {
    params: Promise.resolve({ id: sa }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const get = async (uid = "uid_collab") => {
  const res = await GET(asUser(url(SA), uid), { params: Promise.resolve({ id: SA }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const stored = (sa = SA) => mem.read(`subAccounts/${sa}`)?.reviewsAutoReply as Record<string, unknown> | undefined;
const patchSub = (patch: Record<string, unknown>, sa = SA) => mem.seed(`subAccounts/${sa}`, { ...mem.read(`subAccounts/${sa}`)!, ...patch });

const listingOf = (sa: string) => mem.read(`subAccounts/${sa}`)!.googleListing as Record<string, unknown>;

beforeEach(() => {
  engine.available = true;
  resetSync();
  patchSub({ reviewsAiEnabledByAgency: true, reviewsAutoReplyEnabledByAgency: true });
  // The harness gives both sub-accounts the same location; here they differ.
  patchSub({ googleListing: { ...listingOf(OTHER_SA), locationName: LOC_NORTH } }, OTHER_SA);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GET", () => {
  it("any member reads the defaults when nothing is saved", async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toEqual({
      enabled: false, modes: { 1: "approval", 2: "approval", 3: "approval", 4: "auto", 5: "auto" }, includeBacklog: false,
      enabledAt: null, disabledReason: null, gatesOn: true, gate: null, available: true, running: false,
      dailyPostCap: 20, dailyDraftCap: 40,
    });
  });

  it("reports gatesOn false when any one gate is off, and names that gate", async () => {
    const codes = { googleEnabledByAgency: "gate_off", reviewsAiEnabledByAgency: "ai_gate_off", reviewsAutoReplyEnabledByAgency: "auto_reply_gate_off" };
    for (const [gate, code] of Object.entries(codes)) {
      resetSync();
      patchSub({ reviewsAiEnabledByAgency: true, reviewsAutoReplyEnabledByAgency: true, [gate]: false });
      expect((await get()).body).toMatchObject({ gatesOn: false, gate: code });
    }
  });

  it("running is the kill switch as a boolean — exactly \"1\" — never its value", async () => {
    const prior = process.env.REVIEWS_AUTO_REPLY_ENABLED;
    try {
      process.env.REVIEWS_AUTO_REPLY_ENABLED = "1";
      const on = await get();
      expect(on.body.running).toBe(true);
      process.env.REVIEWS_AUTO_REPLY_ENABLED = "true";
      const off = await get();
      expect(off.body.running).toBe(false);
      expect(JSON.stringify(off.body)).not.toContain("REVIEWS_AUTO_REPLY");
      expect(JSON.stringify(off.body)).not.toContain("\"true\"");
    } finally {
      if (prior === undefined) delete process.env.REVIEWS_AUTO_REPLY_ENABLED;
      else process.env.REVIEWS_AUTO_REPLY_ENABLED = prior;
    }
  });

  it("disabledReason: listing_changed reads through; anything else reads as null", async () => {
    patchSub({ reviewsAutoReply: { enabled: false, modes: MODES, includeBacklog: false, disabledReason: "listing_changed" } });
    expect((await get()).body.disabledReason).toBe("listing_changed");
    patchSub({ reviewsAutoReply: { enabled: false, modes: MODES, includeBacklog: false, disabledReason: "whatever" } });
    expect((await get()).body.disabledReason).toBeNull();
  });

  it("refuses a non-member and another sub-account's admin", async () => {
    expect((await get("uid_stranger")).status).toBe(403);
    expect((await get("uid_other_admin")).status).toBe(403);
  });
});

it("a PUT cannot set or keep disabledReason itself (400, nothing written)", async () => {
  expect((await put({ ...OFF, disabledReason: "listing_changed" })).status).toBe(400);
  expect(stored()).toBeUndefined();
});

describe("who may PUT", () => {
  it.each([
    ["a collaborator", "uid_collab"],
    ["a non-member", "uid_stranger"],
    ["another sub-account's admin", "uid_other_admin"],
  ])("refuses %s (403)", async (_l, uid) => {
    expect((await put(OFF, uid)).status).toBe(403);
    expect(stored()).toBeUndefined();
  });

  it("writes only its own sub-account", async () => {
    expect((await put(ON)).status).toBe(200);
    expect(stored(OTHER_SA)).toBeUndefined();
  });
});

describe("the engine flag (PR 1 ships without the engine)", () => {
  it("refuses enabling with 409 not_available while the engine is unavailable, writing nothing", async () => {
    engine.available = false;
    const res = await put(ON);
    expect([res.status, res.body.code]).toEqual([409, "not_available"]);
    expect(stored()).toBeUndefined();
  });

  it("still saves modes and backlog with enabled false", async () => {
    engine.available = false;
    const res = await put({ ...OFF, includeBacklog: true, modes: { ...MODES, 3: "auto" } });
    expect(res.status).toBe(200);
    expect(stored()).toMatchObject({ enabled: false, includeBacklog: true, modes: { 3: "auto" } });
  });
});

describe("gates", () => {
  it.each([
    ["googleEnabledByAgency", "gate_off"],
    ["reviewsAiEnabledByAgency", "ai_gate_off"],
    ["reviewsAutoReplyEnabledByAgency", "auto_reply_gate_off"],
  ])("enabling with %s off is 403 %s", async (gate, code) => {
    patchSub({ [gate]: false });
    const res = await put(ON);
    expect([res.status, res.body.code]).toEqual([403, code]);
    expect(stored()).toBeUndefined();
  });

  it("turning off is allowed with every gate off", async () => {
    expect((await put(ON)).status).toBe(200);
    patchSub({ googleEnabledByAgency: false, reviewsAiEnabledByAgency: false, reviewsAutoReplyEnabledByAgency: false });
    expect((await put(OFF)).status).toBe(200);
    expect(stored()?.enabled).toBe(false);
  });
});

describe("strict body", () => {
  it.each([
    ["an unknown key", { ...ON, autoPost: true }],
    ["a missing key", { enabled: true, modes: MODES }],
    ["a missing star", { ...ON, modes: { 1: "auto", 2: "auto", 3: "auto", 4: "auto" } }],
    ["an extra star", { ...ON, modes: { ...MODES, 6: "auto" } }],
    ["a bad mode", { ...ON, modes: { ...MODES, 5: "post" } }],
    ["a string enabled", { ...ON, enabled: "true" }],
    ["a number includeBacklog", { ...ON, includeBacklog: 1 }],
    ["modes as an array", { ...ON, modes: ["auto", "auto", "auto", "auto", "auto"] }],
    ["an array body", [ON]],
    ["not JSON", "not json"],
  ])("refuses %s with 400 invalid_body, writing nothing", async (_l, bad) => {
    const res = await put(bad);
    expect([res.status, res.body.code]).toEqual([400, "invalid_body"]);
    expect(stored()).toBeUndefined();
  });
});

describe("transition stamping", () => {
  it("off→on stamps enabledAt, enabledByUid and the listing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T08:00:00Z"));
    const res = await put(ON);
    expect(res.status).toBe(200);
    expect(stored()).toMatchObject({ enabled: true, enabledByUid: "uid_admin", listingLocationName: LOC_A, updatedByUid: "uid_admin" });
    expect((stored()?.enabledAt as Date).toISOString()).toBe("2026-09-26T08:00:00.000Z");
    expect(res.body).toMatchObject({ reviewsAutoReply: { enabled: true, enabledAt: "2026-09-26T08:00:00.000Z" } });
  });

  it("on→on keeps the original enabledAt and listing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T08:00:00Z"));
    await put(ON);
    vi.setSystemTime(new Date("2026-09-27T08:00:00Z"));
    patchSub({ googleListing: { ...(mem.read(`subAccounts/${SA}`)!.googleListing as object), locationName: "locations/other" } });
    expect((await put({ ...ON, includeBacklog: true })).status).toBe(200);
    expect((stored()?.enabledAt as Date).toISOString()).toBe("2026-09-26T08:00:00.000Z");
    expect(stored()).toMatchObject({ includeBacklog: true, listingLocationName: LOC_A });
    expect((stored()?.updatedAt as Date).toISOString()).toBe("2026-09-27T08:00:00.000Z");
  });

  it("on→off clears nothing but enabled; the next off→on re-stamps", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T08:00:00Z"));
    await put(ON);
    await put(OFF);
    expect(stored()).toMatchObject({ enabled: false, enabledByUid: "uid_admin", listingLocationName: LOC_A });
    expect((stored()?.enabledAt as Date).toISOString()).toBe("2026-09-26T08:00:00.000Z");
    vi.setSystemTime(new Date("2026-09-28T08:00:00Z"));
    await put(ON);
    expect((stored()?.enabledAt as Date).toISOString()).toBe("2026-09-28T08:00:00.000Z");
  });

  it("refuses enabling when another sub-account selected the same Google location (409 listing_shared)", async () => {
    patchSub({ googleListing: { ...listingOf(OTHER_SA), locationName: LOC_A } }, OTHER_SA);
    const res = await put(ON);
    expect([res.status, res.body.code]).toEqual([409, "listing_shared"]);
    expect(stored()).toBeUndefined();
    expect((await put(OFF)).status).toBe(200); // turning off is never refused
  });

  it("refuses off→on without a selected listing (409 no_listing)", async () => {
    patchSub({ googleListing: null });
    const res = await put(ON);
    expect([res.status, res.body.code]).toEqual([409, "no_listing"]);
    expect(stored()).toBeUndefined();
  });

  it("saving while off never stamps", async () => {
    expect((await put(OFF)).status).toBe(200);
    expect(stored()).toMatchObject({ enabled: false, enabledAt: null, enabledByUid: null, listingLocationName: null });
  });
});
