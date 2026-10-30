import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Whose name an auto post goes out under, per listing (MULTI_LISTING_V1_PLAN.md
 * PR 6): each post under ITS listing's enabler, re-checked in confirm's
 * transaction, and confirm's backlog check on the listing's OWN enabledAt.
 * `hook.during` runs inside the draft call — after decide(), before confirm.
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

import { createHash } from "node:crypto";
import { ACCOUNT, LOC_A, LOC_NORTH, OTHER_SA, SA, mem, seedExtraListing } from "@/test/gbp-sync-harness";
import { events } from "@/test/gbp-reply-harness";
import {
  ENABLED_AT, patchSettings, postsOn, ratingOnlyOn, resetAutoReply, reviewNameOf, switchExtraOn, syncAllAndRun,
} from "@/test/auto-reply-harness";
import { reviewsCollection } from "@/lib/gbp/sync/types";

const ORIGINAL = { ...process.env };
const B_NAME = (id: string) => `${ACCOUNT}/${LOC_NORTH}/reviews/${id}`;
const docId = (name: string) => createHash("sha256").update(name).digest("hex").slice(0, 40);
const northDoc = (id: string) => mem.list(reviewsCollection(SA)).find((d) => d.reviewId === id);

/** reviewName → the uid it was posted on behalf of, from the reply_posted events AND the audit rows. */
function postedUnder(names: string[]) {
  const byId = new Map(names.map((n) => [docId(n), n]));
  const fromEvents = Object.fromEntries(events(SA, "reply_posted").map((e) => [byId.get(String(e.reviewDocId)), e.createdByUid]));
  const audit = mem.list("auditEvents").filter((r) => r.action === "review.auto_replied");
  const fromAudit = Object.fromEntries(audit.map((r) => [byId.get((r.target as { id: string }).id), r.createdByUid]));
  return { fromEvents, fromAudit };
}

beforeEach(() => {
  resetAutoReply();
  hook.during = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const other = mem.read(`subAccounts/${OTHER_SA}`)!;
  mem.seed(`subAccounts/${OTHER_SA}`, { ...other, googleListing: { ...(other.googleListing as object), locationName: "locations/elsewhere" } });
  seedExtraListing(SA, LOC_NORTH, [ratingOnlyOn(LOC_NORTH, "north-4", 4, 30)]);
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("both on, switched on by different admins", () => {
  it("each post goes out under its OWN listing's enabler (event and audit)", async () => {
    patchSettings({ enabledByUid: "uid_m" });
    switchExtraOn(LOC_NORTH, ENABLED_AT, "uid_b");
    await syncAllAndRun();
    const names = [B_NAME("north-4"), reviewNameOf("fake-a1"), reviewNameOf("fake-a2")];
    const want = { [B_NAME("north-4")]: "uid_b", [reviewNameOf("fake-a1")]: "uid_m", [reviewNameOf("fake-a2")]: "uid_m" };
    expect(postedUnder(names)).toEqual({ fromEvents: want, fromAudit: want });
  });
});

describe("B switched off and on again mid-run", () => {
  it("by another admin: no post under the old enabler; the next run posts under the new one", async () => {
    patchSettings({ enabled: false, includeBacklog: true });
    switchExtraOn(LOC_NORTH, ENABLED_AT, "uid_x");
    hook.during = () => {
      patchSettings({ extraListings: {} });
      switchExtraOn(LOC_NORTH, new Date(), "uid_y");
    };
    await syncAllAndRun();
    expect(postsOn(LOC_NORTH)).toEqual([]);
    expect(northDoc("north-4")?.pendingReply).toMatchObject({ reason: "auto_queued", text: expect.any(String) });

    hook.during = null;
    await syncAllAndRun();
    expect(postsOn(LOC_NORTH).map((p) => p.reviewName)).toEqual([B_NAME("north-4")]);
    expect(postedUnder([B_NAME("north-4")]).fromEvents).toEqual({ [B_NAME("north-4")]: "uid_y" });
  });

  it("backlog off, by the same admin, after the review was written: confirm holds it on B's OWN enabledAt", async () => {
    switchExtraOn(LOC_NORTH, ENABLED_AT, "uid_x");
    hook.during = () => {
      hook.during = null; // once: inside north-4's draft (the newest review)
      patchSettings({ extraListings: {} });
      switchExtraOn(LOC_NORTH, new Date(), "uid_x");
    };
    await syncAllAndRun();
    expect(postsOn(LOC_NORTH)).toEqual([]);
    expect(northDoc("north-4")?.pendingReply).toMatchObject({ reason: "approval", text: expect.any(String) });
    // Main (enabled on the 25th) still posts.
    expect(postsOn(LOC_A)).toHaveLength(2);
  });
});
