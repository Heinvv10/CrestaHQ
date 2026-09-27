import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET …/gbp/reviews — review auto-reply's "Needs approval" (AUTO_REPLY_V1_PLAN.md,
 * UI): the `approval=needed` filter and its count, each row's reason and the
 * draft text for the composer, the "Auto-replied" flag — and nothing else of
 * `pendingReply` (textHash, basisHash, model stay server-side). Real route
 * and sync on the in-memory store; `pendingReply` states seeded directly.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { LEAK_MARKERS, LOC_A, OTHER_SA, SA, asUser, mem } from "@/test/gbp-sync-harness";
import { reviewPath } from "@/test/gbp-reply-harness";
import { patchSettings, patchSub, resetAutoReply, sync } from "@/test/auto-reply-harness";
import { reviewBasis } from "@/lib/reputation/sentiment-basis";
import { GET } from "./route";

const ORIGINAL = { ...process.env };
const MODEL = "model-marker-9Z";
const TEXT_HASH = "texthash-marker-7Q";

type Row = { reviewId: string; autoReplied: boolean; approval: { state: string; draft: string | null } | null };
async function read(query = "") {
  const res = await GET(asUser(`http://127.0.0.1:3100/api/sub-accounts/${SA}/gbp/reviews${query}`, "uid_collab"), {
    params: Promise.resolve({ id: SA }),
  });
  const text = await res.text();
  expect(text).not.toMatch(LEAK_MARKERS);
  const body = JSON.parse(text) as { reviews?: Row[]; needsApproval?: number; code?: string; field?: string };
  return { status: res.status, text, body, ids: (body.reviews ?? []).map((r) => r.reviewId) };
}
const row = async (reviewId: string) => (await read()).body.reviews!.find((r) => r.reviewId === reviewId)!;

const doc = (id: string) => mem.read(reviewPath(id))!;
const basisOf = (id: string) => reviewBasis(doc(id) as Parameters<typeof reviewBasis>[0])!;
function pend(id: string, reason: string, over: Record<string, unknown> = {}) {
  mem.seed(reviewPath(id), {
    ...doc(id),
    pendingReply: { text: `Draft for ${id}`, textHash: TEXT_HASH, basisHash: basisOf(id), reason, at: new Date(), model: MODEL, ...over },
  });
}

beforeEach(async () => {
  resetAutoReply();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await sync();
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("the filter: present, fresh, not dismissed, unreplied", () => {
  beforeEach(() => {
    pend("fake-r6", "approval"); // in
    pend("fake-r5", "approval", { basisHash: "an-older-basis" }); // stale
    pend("fake-r4", "dismissed", { text: null }); // a Discard
    pend("fake-r7", "approval"); // already replied
    pend("fake-r1", "not-a-reason"); // not a pending state
  });

  it("serves only the fresh, undismissed, unreplied draft, and counts it over the unfiltered set", async () => {
    const { ids, body } = await read("?approval=needed");
    expect(ids).toEqual(["fake-r6"]);
    expect(body.needsApproval).toBe(1);
    expect((await read()).body.needsApproval).toBe(1);
    expect((await read("?rating=1")).body.needsApproval).toBe(1);
  });

  it("combines with the other filters", async () => {
    expect((await read("?approval=needed&rating=5")).ids).toEqual([]);
    expect((await read("?approval=needed&rating=2")).ids).toEqual(["fake-r6"]);
  });

  it("a stale, dismissed or replied draft is not offered to the composer", async () => {
    for (const id of ["fake-r5", "fake-r4", "fake-r7", "fake-r1", "fake-r2"]) expect((await row(id)).approval).toBeNull();
    expect((await row("fake-r6")).approval).toEqual({ state: "held", draft: "Draft for fake-r6" });
  });

  it("a review not served (another listing) is not counted", async () => {
    mem.seed(reviewPath("fake-r6"), { ...doc("fake-r6"), locationName: "locations/some-other" });
    expect((await read()).body.needsApproval).toBe(0);
  });

  it("400 on any other approval value", async () => {
    expect((await read("?approval=all")).body).toMatchObject({ code: "invalid_filter", field: "approval" });
    expect((await read("?approval=all")).status).toBe(400);
  });
});

describe("each row's reason", () => {
  it.each([
    ["approval", "held"],
    ["texted", "held"],
    ["draft_failed", "draft_failed"],
    ["post_failed", "post_failed"],
    ["no_budget", "over_limit"],
    ["cap", "over_limit"],
  ])("%s → %s", async (reason, state) => {
    pend("fake-r6", reason);
    expect((await row("fake-r6")).approval?.state).toBe(state);
  });

  it("a draft without text still shows its reason, with nothing to pre-fill", async () => {
    pend("fake-r6", "draft_failed", { text: null, textHash: null });
    expect((await row("fake-r6")).approval).toEqual({ state: "draft_failed", draft: null });
  });

  it("auto_queued is queued only while the engine would post that star; paused otherwise", async () => {
    process.env.REVIEWS_AUTO_REPLY_ENABLED = "1";
    pend("fake-r4", "auto_queued"); // 5★, Auto
    pend("fake-r6", "auto_queued"); // 2★, Approval
    expect((await row("fake-r4")).approval?.state).toBe("queued");
    expect((await row("fake-r6")).approval?.state).toBe("paused");

    const pausedBy: Array<[string, () => void]> = [
      ["the kill switch unset", () => delete process.env.REVIEWS_AUTO_REPLY_ENABLED],
      ["auto-reply switched off", () => patchSettings({ enabled: false })],
      ["the auto-reply gate off", () => patchSub({ reviewsAutoReplyEnabledByAgency: false })],
      ["the Reviews AI gate off", () => patchSub({ reviewsAiEnabledByAgency: false })],
      ["enabled for another listing", () => patchSettings({ listingLocationName: "locations/other" })],
      ["another sub-account on the same location (listing_shared)", () => {
        const other = mem.read(`subAccounts/${OTHER_SA}`)!;
        mem.seed(`subAccounts/${OTHER_SA}`, { ...other, googleListing: { ...(other.googleListing as object), locationName: LOC_A } });
      }],
      ["another sub-account holding the location only as an extra listing (listing_shared)", () => {
        const other = mem.read(`subAccounts/${OTHER_SA}`)!;
        mem.seed(`subAccounts/${OTHER_SA}`, {
          ...other,
          googleExtraListings: [{ ...(other.googleListing as object), locationName: LOC_A }],
          googleLocationNames: [(other.googleListing as { locationName: string }).locationName, LOC_A],
        });
      }],
    ];
    for (const [label, pause] of pausedBy) {
      resetAutoReply();
      await sync();
      process.env.REVIEWS_AUTO_REPLY_ENABLED = "1";
      pend("fake-r4", "auto_queued");
      pause();
      expect({ label, state: (await row("fake-r4")).approval?.state }).toEqual({ label, state: "paused" });
    }
  });
});

describe("what leaves the server", () => {
  it("only the reason and the draft text — never textHash, basisHash, model or time", async () => {
    pend("fake-r6", "approval");
    const { text } = await read("?approval=needed");
    expect(text).toContain("Draft for fake-r6");
    for (const marker of [TEXT_HASH, MODEL, basisOf("fake-r6"), "textHash", "basisHash", "pendingReply"]) expect(text).not.toContain(marker);
  });

  it("autoReplied marks a reply review auto-reply posted", async () => {
    mem.seed(reviewPath("fake-r7"), { ...doc("fake-r7"), autoReplied: { at: new Date(), key: "auto:x:y" } });
    expect((await row("fake-r7")).autoReplied).toBe(true);
    expect((await row("fake-r6")).autoReplied).toBe(false);
    expect((await read()).text).not.toContain("auto:x:y");
  });
});
