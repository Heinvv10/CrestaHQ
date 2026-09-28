import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Auto-reply per listing when listings change (MULTI_LISTING_V1_PLAN.md PR 6,
 * tests (d)–(f)): another sub-account takes the extra listing mid-run, the
 * extra is switched off mid-run, removed while on, or the MAIN listing
 * changes while the extra is on. `hook.during` runs inside the draft call —
 * after decide(), before confirm's final re-check.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const hook = vi.hoisted(() => ({ during: null as null | (() => Promise<void> | void) }));
vi.mock("@/lib/reputation/ai/select", async (orig) => {
  const real = await orig<typeof import("@/lib/reputation/ai/select")>();
  return {
    ...real,
    getReviewsAiFor: async (sa: string) => {
      const ai = await real.getReviewsAiFor(sa);
      return {
        ...ai,
        draftReply: async (input: Parameters<typeof ai.draftReply>[0]) => {
          const result = await ai.draftReply(input);
          await hook.during?.();
          return result;
        },
      };
    },
  };
});

import { ACCOUNT, LOC_A, LOC_NORTH, OTHER_SA, SA, asUser, mem, seedExtraListing, setScenario } from "@/test/gbp-sync-harness";
import {
  patchSettings, posts, postsOn, ratingOnlyOn, resetAutoReply, reviewNameOf, switchExtraOn, syncAllAndRun,
} from "@/test/auto-reply-harness";
import { removeExtraListings, saveExtraListings } from "@/lib/gbp/extra-listings";
import { clearListing } from "@/lib/gbp/listing-events";
import { locId } from "@/lib/gbp/listings";
import { reviewsCollection } from "@/lib/gbp/sync/types";
import { PUT as PUT_LISTING } from "@/app/api/sub-accounts/[id]/google/listing/route";
import { autoReplyAlertsCollection } from "./alerts";

const ORIGINAL = { ...process.env };
const LOC_C = "locations/e2e-velo-third";
const B = { accountName: ACCOUNT, locationName: LOC_NORTH };
const sub = () => mem.read(`subAccounts/${SA}`)!;
const settings = () => sub().reviewsAutoReply as Record<string, unknown>;
const alerts = () => mem.list(autoReplyAlertsCollection(SA));
const northDoc = (id: string) => mem.list(reviewsCollection(SA)).find((d) => d.reviewId === id);

beforeEach(() => {
  resetAutoReply();
  hook.during = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const other = mem.read(`subAccounts/${OTHER_SA}`)!;
  mem.seed(`subAccounts/${OTHER_SA}`, { ...other, googleListing: { ...(other.googleListing as object), locationName: "locations/elsewhere" } });
  seedExtraListing(SA, LOC_NORTH, [ratingOnlyOn(LOC_NORTH, "north-4", 4, 30), ratingOnlyOn(LOC_NORTH, "north-5", 5, 29)]);
  switchExtraOn(LOC_NORTH);
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("(d) changed mid-run: only B waits, main still posts", () => {
  it("another sub-account adds B as an EXTRA listing → B's reviews are not posted (drafts stay queued); main's post", async () => {
    hook.during = () => {
      const other = mem.read(`subAccounts/${OTHER_SA}`)!;
      const extra = { ...(other.googleListing as object), locationName: LOC_NORTH };
      mem.seed(`subAccounts/${OTHER_SA}`, { ...other, googleExtraListings: [extra], googleLocationNames: ["locations/elsewhere", LOC_NORTH] });
    };
    await syncAllAndRun();
    expect(postsOn(LOC_NORTH)).toEqual([]);
    expect(northDoc("north-4")?.pendingReply).toMatchObject({ reason: "auto_queued", text: expect.any(String) });
    expect(postsOn(LOC_A).map((p) => p.reviewName).sort()).toEqual([reviewNameOf("fake-a1"), reviewNameOf("fake-a2")].sort());
  });

  it("B switched off mid-run → B's reviews are not posted (drafts stay queued); main's post", async () => {
    hook.during = () => patchSettings({ extraListings: {} });
    await syncAllAndRun();
    expect(postsOn(LOC_NORTH)).toEqual([]);
    expect(northDoc("north-4")?.pendingReply).toMatchObject({ reason: "auto_queued" });
    expect(postsOn(LOC_A)).toHaveLength(2);
  });
});

describe("(e) removing B while it is on", () => {
  it("deletes B's key in the removal write, sends exactly one listing_changed alert; main posts, B never again", async () => {
    await syncAllAndRun();
    const before = posts().length;
    expect(postsOn(LOC_NORTH)).toHaveLength(2);
    // A new B review at Google that a surviving switch would post.
    setScenario(SA, (s) => void s.reviews[LOC_NORTH].reviews.unshift(ratingOnlyOn(LOC_NORTH, "north-6", 5, 31)));

    const result = await saveExtraListings(SA, "uid_admin", [], [B], new Map());
    expect(result).toMatchObject({ ok: true, removed: [LOC_NORTH] });
    expect(sub().googleExtraListings).toEqual([]);
    expect(settings().extraListings).toEqual({});
    expect(settings()).toMatchObject({ enabled: true, listingLocationName: LOC_A });
    expect(alerts().map((a) => a.kind)).toEqual(["listing_changed"]);

    putMainReview("fake-a9", 30);
    await syncAllAndRun();
    expect(postsOn(LOC_A).map((p) => p.reviewName)).toContain(reviewNameOf("fake-a9"));
    expect(postsOn(LOC_NORTH)).toHaveLength(2);
    expect(posts().length).toBe(before + 1);
    expect(alerts()).toHaveLength(1);
  });

  it("removing B while it is OFF sends no alert and leaves reviewsAutoReply as it was", async () => {
    patchSettings({ extraListings: {} });
    const was = structuredClone(settings());
    await saveExtraListings(SA, "uid_admin", [], [B], new Map());
    expect(settings()).toEqual(was);
    expect(alerts()).toEqual([]);
  });
});

describe("the other removal paths", () => {
  it("a reconnect that can no longer see B removes its key in the same write, with one alert", async () => {
    expect(await removeExtraListings(SA, "uid_admin", [B], "not_accessible_after_reconnect")).toEqual([LOC_NORTH]);
    expect(settings().extraListings).toEqual({});
    expect(alerts().map((a) => a.kind)).toEqual(["listing_changed"]);
  });

  it("clearing every listing (disconnect) deletes all keys, main off with its reason, one alert — also with main already off", async () => {
    patchSettings({ enabled: false });
    await clearListing(SA, "uid_admin", "disconnected");
    expect(settings().extraListings).toBeUndefined();
    expect(settings()).toMatchObject({ enabled: false, disabledReason: "listing_changed" });
    expect(alerts().map((a) => a.kind)).toEqual(["listing_changed"]);
  });
});

describe("(f) changing the MAIN listing while B is on", () => {
  it("main goes enabled:false with disabledReason; B's switch stays and B still posts", async () => {
    setScenario(SA, (s) => {
      s.locations[ACCOUNT].push({ ...s.locations[ACCOUNT][0], name: LOC_C, title: "Velo Test Fibre — Third" });
      s.reviews[LOC_C] = { averageRating: 5, totalReviewCount: 1, reviews: [ratingOnlyOn(LOC_C, "third-1", 5, 30)] };
    });
    const res = await PUT_LISTING(
      asUser(`http://127.0.0.1:3100/api/sub-accounts/${SA}/google/listing`, "uid_admin", "PUT", JSON.stringify({ accountName: ACCOUNT, locationName: LOC_C })),
      { params: Promise.resolve({ id: SA }) },
    );
    expect(res.status).toBe(200);
    expect(settings()).toMatchObject({ enabled: false, disabledReason: "listing_changed" });
    expect(Object.keys(settings().extraListings as object)).toEqual([locId(LOC_NORTH)]);

    await syncAllAndRun();
    expect(postsOn(LOC_NORTH).map((p) => p.reviewName).sort()).toEqual(
      [`${ACCOUNT}/${LOC_NORTH}/reviews/north-4`, `${ACCOUNT}/${LOC_NORTH}/reviews/north-5`],
    );
    expect(postsOn(LOC_C)).toEqual([]);
    expect(postsOn(LOC_A)).toEqual([]);
  });
});

/** A new rating-only 5★ on main at Google. */
function putMainReview(id: string, day: number) {
  setScenario(SA, (s) => {
    s.reviews[LOC_A].reviews.unshift(ratingOnlyOn(LOC_A, id, 5, day));
  });
}
