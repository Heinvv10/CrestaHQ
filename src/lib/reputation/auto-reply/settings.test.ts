import { describe, expect, it } from "vitest";

import {
  AUTO_REPLY_ENGINE_AVAILABLE, extraListingWrites, nextAutoReplySettings, parseAutoReplyBody, readAutoReplyListings, readAutoReplySettings,
} from "./settings";

/** Pure settings helpers (AUTO_REPLY_V1_PLAN.md, PR 1); the route test covers the wiring. */

const MODES = { 1: "approval", 2: "approval", 3: "approval", 4: "auto", 5: "auto" } as const;

it("the engine is available since PR 2 (the kill switch decides whether it runs)", () => {
  expect(AUTO_REPLY_ENGINE_AVAILABLE).toBe(true);
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

  it("keeps a stored Firestore Timestamp as enabledAt, and drops anything that is not a stamp", () => {
    const ts = { toMillis: () => 1, toDate: () => new Date(1) };
    const keep = nextAutoReplySettings({ enabled: true, enabledAt: ts }, on, ctx);
    expect(keep.ok && keep.value.enabledAt).toBe(ts);
    const junk = nextAutoReplySettings({ enabled: true, enabledAt: {} }, on, ctx);
    expect(junk.ok && junk.value.enabledAt).toBeNull();
  });

  it("refuses off→on without a listing, but not a save while off", () => {
    expect(nextAutoReplySettings(undefined, on, { ...ctx, listingLocationName: null })).toEqual({ ok: false, code: "no_listing" });
    expect(nextAutoReplySettings(undefined, { ...on, enabled: false }, { ...ctx, listingLocationName: null }).ok).toBe(true);
  });

  it("keeps disabledReason only while auto-reply stays off without an admin's switch", () => {
    const changed = { enabled: false, disabledReason: "listing_changed" };
    const off = { ...on, enabled: false };
    // A save while still off (a star changed) keeps the note.
    expect(nextAutoReplySettings(changed, off, ctx)).toMatchObject({ ok: true, value: { disabledReason: "listing_changed" } });
    // Switching on clears it.
    expect(nextAutoReplySettings(changed, on, ctx)).toMatchObject({ ok: true, value: { disabledReason: null } });
    // An admin's own on→off is not a listing change.
    expect(nextAutoReplySettings({ enabled: true, disabledReason: "listing_changed" }, off, ctx))
      .toMatchObject({ ok: true, value: { disabledReason: null } });
    // Anything but the one known value reads as none.
    expect(nextAutoReplySettings({ enabled: false, disabledReason: "other" }, off, ctx))
      .toMatchObject({ ok: true, value: { disabledReason: null } });
  });
});

describe("per listing (MULTI_LISTING_V1_PLAN.md PR 6)", () => {
  const MAIN = "locations/main";
  const B = "locations/b";
  const at = new Date("2026-09-27T08:00:00Z");
  const listing = (locationName: string) => ({ locationName, title: locationName }) as never;
  const sub = { googleListing: listing(MAIN), googleExtraListings: [listing(B)] };
  const raw = { enabled: true, listingLocationName: MAIN, enabledAt: at, enabledByUid: "u1", extraListings: { b: { enabledAt: at, enabledByUid: "u2" } } };

  it("main while enabled for the current main; an extra while its key exists AND it is connected", () => {
    expect(readAutoReplyListings(raw, sub)).toEqual({
      [MAIN]: { enabledAtMs: at.getTime(), enabledByUid: "u1" },
      [B]: { enabledAtMs: at.getTime(), enabledByUid: "u2" },
    });
    expect(Object.keys(readAutoReplyListings({ ...raw, enabled: false }, sub))).toEqual([B]);
    expect(Object.keys(readAutoReplyListings({ ...raw, listingLocationName: "locations/old" }, sub))).toEqual([B]);
    // A stale key: B no longer connected.
    expect(Object.keys(readAutoReplyListings(raw, { googleListing: listing(MAIN) }))).toEqual([MAIN]);
    // A key without its stamp is off.
    expect(Object.keys(readAutoReplyListings({ ...raw, extraListings: { b: {} } }, sub))).toEqual([MAIN]);
    // Legacy: no extraListings.
    expect(Object.keys(readAutoReplyListings({ enabled: true, listingLocationName: MAIN }, sub))).toEqual([MAIN]);
    expect(readAutoReplyListings(undefined, sub)).toEqual({});
  });

  it("parseAutoReplyBody accepts an optional listings map of booleans only", () => {
    const base = { enabled: false, modes: MODES, includeBacklog: false };
    expect(parseAutoReplyBody({ ...base, listings: { [B]: true } })).toMatchObject({ listings: { [B]: true } });
    expect(parseAutoReplyBody(base)).not.toHaveProperty("listings");
    for (const bad of [{ [B]: 1 }, { b: true }, [B], null]) expect(parseAutoReplyBody({ ...base, listings: bad })).toBeNull();
  });

  it("extraListingWrites: off→on stamps, on→on keeps (no write), on→off deletes, off→off nothing", () => {
    const ctx = { now: new Date("2026-09-28T08:00:00Z"), uid: "u3" };
    expect(extraListingWrites(raw, sub, { [B]: true }, ctx)).toEqual({});
    expect(extraListingWrites(raw, sub, { [B]: false }, ctx)).toEqual({ b: null });
    expect(extraListingWrites({}, sub, { [B]: true }, ctx)).toEqual({ b: { enabledAt: ctx.now, enabledByUid: "u3" } });
    expect(extraListingWrites({}, sub, { [B]: false }, ctx)).toEqual({});
  });
});
