import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { ACCOUNT, LOC_A, LOC_NORTH, OTHER_SA, SA, asUser, mem, removeExtraListings, reviewOn, seedExtraListing } from "@/test/gbp-sync-harness";
import {
  draftsMade, patchSettings, pendingOf, posts, postsOn, ratingOnlyOn, resetAutoReply, reviewNameOf, switchExtraOn, syncAllAndRun,
} from "@/test/auto-reply-harness";
import { syncSubAccount } from "@/lib/gbp/sync/sub-account";
import { reviewsCollection } from "@/lib/gbp/sync/types";
import { PUT as PUT_SETTINGS } from "@/app/api/sub-accounts/[id]/reputation/auto-reply/route";
import { autoReplyAfterSync } from "./run";
import { autoReplyUsagePath, sastDay } from "./store";

/**
 * Auto-reply per listing (MULTI_LISTING_V1_PLAN.md PR 6, tests (a)–(c), (g)):
 * real sync of both listings, the real engine, the fake GBP provider's
 * putReply log, in-memory Firestore. Extra listing B = LOC_NORTH with two
 * rating-only reviews newer than main's (north-4 on the 30th, north-5 on the
 * 29th); main (LOC_A) has fake-a1 (28th) and fake-a2 (26th).
 */

const ORIGINAL = { ...process.env };
const B_NAME = (id: string) => `${ACCOUNT}/${LOC_NORTH}/reviews/${id}`;
const docsOn = (loc: string) => mem.list(reviewsCollection(SA)).filter((d) => d.locationName === loc);
const MODES = { 1: "approval", 2: "approval", 3: "approval", 4: "auto", 5: "auto" };

beforeEach(() => {
  resetAutoReply();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // Take OTHER_SA off LOC_NORTH so the extra is not "shared" (paused).
  const other = mem.read(`subAccounts/${OTHER_SA}`)!;
  mem.seed(`subAccounts/${OTHER_SA}`, { ...other, googleListing: { ...(other.googleListing as object), locationName: "locations/elsewhere" } });
  seedExtraListing(SA, LOC_NORTH, [ratingOnlyOn(LOC_NORTH, "north-4", 4, 30), ratingOnlyOn(LOC_NORTH, "north-5", 5, 29)]);
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("an extra listing that is OFF", () => {
  it("is never touched: zero drafts, zero pendingReply, zero posts on it; main still posts", async () => {
    const before = draftsMade();
    await syncAllAndRun();
    expect(docsOn(LOC_NORTH).length).toBe(2);
    for (const d of docsOn(LOC_NORTH)) expect(d.pendingReply ?? null).toBeNull();
    expect(postsOn(LOC_NORTH)).toEqual([]);
    expect(posts().map((p) => p.reviewName).sort()).toEqual([reviewNameOf("fake-a1"), reviewNameOf("fake-a2")].sort());
    expect(draftsMade()).toBe(before + 2);
  });
});

describe("(a) B on, main off", () => {
  it("B's rating-only reviews post once each to B's own review names; main's are untouched", async () => {
    patchSettings({ enabled: false });
    switchExtraOn(LOC_NORTH);
    const { run } = await syncAllAndRun();
    expect(run).toMatchObject({ posted: 2, stop: null });
    expect(posts().map((p) => p.reviewName).sort()).toEqual([B_NAME("north-4"), B_NAME("north-5")]);
    expect(postsOn(LOC_A)).toEqual([]);
    for (const d of docsOn(LOC_A)) expect(d.pendingReply ?? null).toBeNull();
    // On behalf of whoever switched B on.
    const audit = mem.list("auditEvents").filter((r) => r.action === "review.auto_replied");
    expect(audit.map((r) => r.createdByUid)).toEqual(["uid_extra_admin", "uid_extra_admin"]);

    await syncAllAndRun();
    expect(posts()).toHaveLength(2);
  });

  it("texted reviews on an extra listing go to approval, as on main", async () => {
    patchSettings({ enabled: false });
    switchExtraOn(LOC_NORTH);
    seedExtraListing(SA, LOC_NORTH, [reviewOn(LOC_NORTH, "north-t", 5, 29)]);
    await syncAllAndRun();
    expect(posts()).toEqual([]);
    const doc = docsOn(LOC_NORTH).find((d) => d.reviewId === "north-t")!;
    expect(doc.pendingReply).toMatchObject({ reason: "texted", text: expect.any(String) });
  });
});

describe("(b) both on", () => {
  it("both listings post and share ONE daily cap: the 21st is held `cap`", async () => {
    switchExtraOn(LOC_NORTH);
    mem.seed(autoReplyUsagePath(SA), { day: sastDay(Date.now()), posts: 17 });
    await syncAllAndRun();
    // Newest first across listings: north-4, north-5 (B), fake-a1 (main) post → 20; fake-a2 is the 21st.
    expect(posts().map((p) => p.reviewName).sort()).toEqual([B_NAME("north-4"), B_NAME("north-5"), reviewNameOf("fake-a1")].sort());
    expect(mem.read(autoReplyUsagePath(SA))).toMatchObject({ posts: 20 });
    expect(pendingOf("fake-a2")).toMatchObject({ reason: "cap", text: null });
  });
});

describe("(c) B switched on later, backlog off", () => {
  it("B's reviews older than B's own enabledAt are before_enabled; main's (older still) posts", async () => {
    const body = JSON.stringify({ enabled: true, modes: MODES, includeBacklog: false, listings: { [LOC_NORTH]: true } });
    const res = await PUT_SETTINGS(asUser(`http://127.0.0.1:3100/api/sub-accounts/${SA}/reputation/auto-reply`, "uid_admin", "PUT", body), {
      params: Promise.resolve({ id: SA }),
    });
    expect(res.status).toBe(200);
    await syncAllAndRun();
    expect(postsOn(LOC_NORTH)).toEqual([]);
    for (const d of docsOn(LOC_NORTH)) expect(d.pendingReply ?? null).toBeNull();
    expect(postsOn(LOC_A).map((p) => p.reviewName).sort()).toEqual([reviewNameOf("fake-a1"), reviewNameOf("fake-a2")].sort());
  });
});

describe("a stale extraListings key", () => {
  it("for a listing no longer connected never posts, even for reviews the run saw", async () => {
    switchExtraOn(LOC_NORTH);
    // B connected and synced (its reviews seen by this sync), then gone from the
    // listing fields with its key left behind; the engine runs for that sync.
    const { synced } = await syncSubAccount(SA, { trigger: "manual", actorUid: "uid_admin" });
    removeExtraListings(SA);
    expect(docsOn(LOC_NORTH).every((d) => d.state === "active")).toBe(true);
    expect(await autoReplyAfterSync(SA, synced.startedAt, Date.now() + 240_000)).toMatchObject({ stop: null, posted: 2 });
    expect(postsOn(LOC_NORTH)).toEqual([]);
    for (const d of docsOn(LOC_NORTH)) expect(d.pendingReply ?? null).toBeNull();
  });
});

describe("(g) legacy doc", () => {
  it("no extraListings, enabled: true, an extra connected: main behaves as before and the extra is untouched", async () => {
    const stored = mem.read(`subAccounts/${SA}`)!.reviewsAutoReply as Record<string, unknown>;
    expect(stored.extraListings).toBeUndefined();
    const { run } = await syncAllAndRun();
    expect(run).toMatchObject({ posted: 2, drafted: 2, stop: null });
    expect(postsOn(LOC_NORTH)).toEqual([]);
  });
});
