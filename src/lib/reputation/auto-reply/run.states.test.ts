import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One run per row of the `pendingReply` state table (AUTO_REPLY_V1_PLAN.md),
 * plus Discard: discard → rerun → no draft, no post; a Discard during the
 * draft call wins; and a Discard survives a cache clear.
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

import { AGENCY, SA, mem, setScenario } from "@/test/gbp-sync-harness";
import { docIdOf, reviewPath } from "@/test/gbp-reply-harness";
import {
  A1, draftsMade, patchSettings, patchSub, pendingOf, posts, putFixtureReview, replyOf, resetAutoReply, reviewNameOf, sync, syncAndRun,
} from "@/test/auto-reply-harness";
import { clearGbpCache } from "@/lib/gbp/sync/store";
import { sentimentBasis } from "@/lib/reputation/sentiment-basis";
import { autoReplyDismissedCollection, dismissAutoReply, textHashOf } from "./store";

const ORIGINAL = { ...process.env };
const A1_BASIS = sentimentBasis(5, null);
const R6 = docIdOf("fake-r6");
const a1Posts = () => posts().filter((c) => c.reviewName === reviewNameOf("fake-a1"));

function seedPending(reason: string, o: { text?: string | null; basisHash?: string; at?: Date } = {}) {
  const text = o.text === undefined ? (["auto_queued", "approval", "texted"].includes(reason) ? `Stored ${reason} bytes.` : null) : o.text;
  mem.seed(reviewPath("fake-a1"), {
    ...mem.read(reviewPath("fake-a1"))!,
    pendingReply: {
      text, textHash: text === null ? null : textHashOf(text), basisHash: o.basisHash ?? A1_BASIS, reason,
      at: o.at ?? new Date(), model: "fake",
    },
  });
}

beforeEach(async () => {
  resetAutoReply();
  hook.during = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await sync(); // the cache exists; each test seeds a state, then syncs + runs
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("auto_queued", () => {
  it("fresh → posts the stored bytes, no new draft", async () => {
    seedPending("auto_queued");
    await syncAndRun();
    expect(replyOf("fake-a1")).toBe("Stored auto_queued bytes.");
    expect(draftsMade()).toBe(1); // a2 only
  });

  it("stale → the bytes are dropped, re-drafted and posted", async () => {
    seedPending("auto_queued", { basisHash: "old" });
    await syncAndRun();
    expect(replyOf("fake-a1")).toMatch(/5-star review/);
    expect(draftsMade()).toBe(2);
  });
});

describe("approval / texted (held)", () => {
  it.each(["approval", "texted"])("%s fresh → skipped: no draft, no post", async (reason) => {
    seedPending(reason);
    await syncAndRun();
    expect(a1Posts()).toEqual([]);
    expect(pendingOf("fake-a1")).toMatchObject({ reason, text: `Stored ${reason} bytes.` });
    expect(draftsMade()).toBe(1);
  });

  it.each(["approval", "texted"])("%s stale → re-drafted and stays held (even on an Auto star)", async (reason) => {
    seedPending(reason, { basisHash: "old" });
    await syncAndRun();
    expect(a1Posts()).toEqual([]);
    expect(pendingOf("fake-a1")).toMatchObject({ reason, basisHash: A1_BASIS });
    expect(pendingOf("fake-a1")?.text).toMatch(/5-star review/);
  });

  it("an edited review with a held draft → stale, re-drafted from the new content", async () => {
    patchSettings({ includeBacklog: true });
    await syncAndRun();
    expect(pendingOf("fake-r6")?.text).toMatch(/2-star/);
    setScenario(SA, (s) => {
      const r = s.reviews["locations/e2e-velo-gqeberha"].reviews.find((x) => x.reviewId === "fake-r6")!;
      Object.assign(r, { starRating: 3, updateTime: "2026-08-29T09:00:00Z" });
    });
    await syncAndRun();
    expect(pendingOf("fake-r6")).toMatchObject({ reason: "approval", basisHash: sentimentBasis(3, "Fixture review: technician arrived late.") });
    expect(pendingOf("fake-r6")?.text).toMatch(/3-star/);
  });

  it("a reply appearing at Google clears the held draft on the next sync", async () => {
    patchSettings({ includeBacklog: true });
    await syncAndRun();
    setScenario(SA, (s) => {
      const r = s.reviews["locations/e2e-velo-gqeberha"].reviews.find((x) => x.reviewId === "fake-r6")!;
      r.reply = { comment: "Replied in GHL.", updateTime: "2026-08-30T09:00:00Z" };
    });
    await sync();
    expect(pendingOf("fake-r6")).toBeNull();
  });
});

describe("draft_failed", () => {
  it("fresh and under 24 h → no retry", async () => {
    seedPending("draft_failed", { at: new Date(Date.now() - 23 * 3600_000) });
    await syncAndRun();
    expect([a1Posts().length, draftsMade()]).toEqual([0, 1]);
  });

  it("fresh and 24 h old → retried once: drafted and posted", async () => {
    seedPending("draft_failed", { at: new Date(Date.now() - 24 * 3600_000 - 1000) });
    await syncAndRun();
    expect(a1Posts()).toHaveLength(1);
  });

  it("stale → re-decided at once", async () => {
    seedPending("draft_failed", { basisHash: "old" });
    await syncAndRun();
    expect(a1Posts()).toHaveLength(1);
  });
});

describe("no_budget / cap", () => {
  it.each(["no_budget", "cap"])("%s → re-decided; auto-posts now that there is budget", async (reason) => {
    seedPending(reason);
    await syncAndRun();
    expect(a1Posts()).toHaveLength(1);
  });
});

describe("dismissed (Discard)", () => {
  it("fresh → skipped for good; stale → re-decided", async () => {
    seedPending("dismissed");
    await syncAndRun();
    expect(a1Posts()).toEqual([]);
    seedPending("dismissed", { basisHash: "old" });
    await syncAndRun();
    expect(a1Posts()).toHaveLength(1);
  });

  it("discard → rerun → no draft, no post (a queued auto draft included)", async () => {
    hook.during = () => {
      hook.during = null;
      patchSub({ reviewsAutoReplyEnabledByAgency: false }); // pause: a1 stays auto_queued
    };
    await syncAndRun();
    expect(pendingOf("fake-a1")).toMatchObject({ reason: "auto_queued" });
    expect(await dismissAutoReply(SA, A1, "uid_admin", new Date())).toBe(true);
    patchSub({ reviewsAutoReplyEnabledByAgency: true });
    const drafts = draftsMade();
    await syncAndRun();
    expect(a1Posts()).toEqual([]);
    expect(pendingOf("fake-a1")).toMatchObject({ reason: "dismissed", text: null });
    expect(draftsMade()).toBe(drafts + 1); // a2 only
  });

  it("a Discard clicked during the draft call wins: nothing stored, nothing posted", async () => {
    hook.during = async () => {
      hook.during = null;
      await dismissAutoReply(SA, A1, "uid_admin", new Date());
    };
    await syncAndRun();
    expect(a1Posts()).toEqual([]);
    expect(pendingOf("fake-a1")).toMatchObject({ reason: "dismissed" });
  });

  it("survives a cache clear, and the set carries the tenant keys but no content", async () => {
    await dismissAutoReply(SA, A1, "uid_admin", new Date());
    await clearGbpCache(SA);
    expect(mem.read(reviewPath("fake-a1"))).toBeUndefined();
    await syncAndRun();
    expect(pendingOf("fake-a1")).toBeUndefined();
    expect(a1Posts()).toEqual([]);
    expect(posts()).toHaveLength(1); // a2
    const row = mem.read(`${autoReplyDismissedCollection(SA)}/${A1}`)!;
    expect(row).toMatchObject({ agencyId: AGENCY, subAccountId: SA, createdByUid: "uid_admin", byUid: "uid_admin", basisHash: A1_BASIS });
    expect(Object.keys(row).sort()).toEqual(["agencyId", "at", "basisHash", "byUid", "createdByUid", "subAccountId"]);
  });

  it("a dismissed review whose content then changes is decided again", async () => {
    await dismissAutoReply(SA, A1, "uid_admin", new Date());
    putFixtureReview("fake-a1", 4, null, 28);
    await syncAndRun();
    expect(a1Posts()).toHaveLength(1);
  });

  it("dismissing a review not in the cache is refused", async () => {
    expect(await dismissAutoReply(SA, R6.replace(/./, "0"), "uid_admin", new Date())).toBe(false);
  });
});
