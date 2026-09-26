import { describe, expect, it } from "vitest";

import { AUTO_REPLY_ENGINE_AVAILABLE, nextAutoReplySettings, readAutoReplySettings } from "./settings";

/** Pure settings helpers (AUTO_REPLY_V1_PLAN.md, PR 1); the route test covers the wiring. */

const MODES = { 1: "approval", 2: "approval", 3: "approval", 4: "auto", 5: "auto" } as const;

it("ships with the engine unavailable (PR 2 flips it)", () => {
  expect(AUTO_REPLY_ENGINE_AVAILABLE).toBe(false);
});

describe("readAutoReplySettings", () => {
  it("absent reads as off, 1-3★ approval, 4-5★ auto, no backlog", () => {
    expect(readAutoReplySettings(undefined)).toEqual({ enabled: false, modes: MODES, includeBacklog: false });
  });

  it("a malformed stored star falls back to that star's default only", () => {
    const r = readAutoReplySettings({ enabled: "yes", modes: { 1: "auto", 4: "post" }, includeBacklog: true });
    expect(r).toEqual({ enabled: false, modes: { ...MODES, 1: "auto" }, includeBacklog: true });
  });
});

describe("nextAutoReplySettings", () => {
  const ctx = { now: new Date("2026-09-26T08:00:00Z"), uid: "u1", listingLocationName: "locations/a" };
  const on = { enabled: true, modes: { ...MODES }, includeBacklog: false };

  it("stamps on off→on and keeps the stamps otherwise", () => {
    const first = nextAutoReplySettings(undefined, on, ctx);
    expect(first).toMatchObject({ ok: true, value: { enabledAt: ctx.now, enabledByUid: "u1", listingLocationName: "locations/a" } });
    const later = { now: new Date("2026-09-27T08:00:00Z"), uid: "u2", listingLocationName: "locations/b" };
    const again = nextAutoReplySettings(first.ok ? first.value : null, on, later);
    expect(again).toMatchObject({ ok: true, value: { enabledAt: ctx.now, enabledByUid: "u1", listingLocationName: "locations/a", updatedByUid: "u2" } });
  });

  it("refuses off→on without a listing, but not a save while off", () => {
    expect(nextAutoReplySettings(undefined, on, { ...ctx, listingLocationName: null })).toEqual({ ok: false, code: "no_listing" });
    expect(nextAutoReplySettings(undefined, { ...on, enabled: false }, { ...ctx, listingLocationName: null }).ok).toBe(true);
  });
});
