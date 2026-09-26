import { describe, expect, it } from "vitest";

import type { AutoReplyMode, AutoReplyStar } from "@/types";
import { decide, type DecidePending, type DecideReview, type DecideSettings } from "./decide";

/**
 * decide() — the full matrix (AUTO_REPLY_V1_PLAN.md "Validation"): star ×
 * mode × texted/blank × before/after enabledAt × backlog × caps ×
 * replied/pending/tombstone × seen-this-run × listing, and every row of the
 * pendingReply state table. Expectations are written from the plan, not
 * derived from the code.
 */

const LOC = "locations/e2e-velo-gqeberha";
const ENABLED_AT = Date.parse("2026-09-26T08:00:00Z");
const RUN = Date.parse("2026-09-27T10:00:00Z");
const NOW = RUN + 30_000;
const BASIS = "b".repeat(64);
const DAY = 24 * 3600_000;

const ALL_AUTO: Record<AutoReplyStar, AutoReplyMode> = { 1: "auto", 2: "auto", 3: "auto", 4: "auto", 5: "auto" };
const ALL_APPROVAL: Record<AutoReplyStar, AutoReplyMode> = { 1: "approval", 2: "approval", 3: "approval", 4: "approval", 5: "approval" };

const settings = (o: Partial<DecideSettings> = {}): DecideSettings => ({
  enabled: true, modes: { 1: "approval", 2: "approval", 3: "approval", 4: "auto", 5: "auto" }, includeBacklog: false,
  enabledAtMs: ENABLED_AT, listingLocationName: LOC, ...o,
});
const review = (o: Partial<DecideReview> = {}): DecideReview => ({
  state: "active", locationName: LOC, starRating: 5, comment: null, createTimeMs: ENABLED_AT + DAY, lastSeenAtMs: RUN,
  hasReply: false, hadReply: false, inFlight: false, autoReplied: false, basisHash: BASIS, pending: null, dismissedBasisHash: null, ...o,
});
const pending = (reason: DecidePending["reason"], o: Partial<DecidePending> = {}): DecidePending => ({
  reason, basisHash: BASIS, atMs: NOW - 60_000, hasText: reason === "auto_queued" || reason === "approval" || reason === "texted", ...o,
});
const counts = (postsToday = 0, autoDraftsToday = 0) => ({ postsToday, autoDraftsToday });
const run = (r: Partial<DecideReview> = {}, s: Partial<DecideSettings> = {}, c = counts()) =>
  decide(review(r), settings(s), { now: NOW, runStartedAt: RUN }, c);

describe("star × mode × texted/blank", () => {
  const stars: AutoReplyStar[] = [1, 2, 3, 4, 5];
  const comments: Array<[string, string | null, boolean]> = [
    ["no comment", null, false], ["empty", "", false], ["whitespace", "  \n\t ", false],
    ["text", "Great service", true], ["padded text", "  ok  ", true],
  ];
  for (const star of stars) {
    for (const mode of ["auto", "approval"] as const) {
      for (const [label, comment, texted] of comments) {
        const expected = mode === "approval"
          ? { verdict: "hold", reason: "approval", draft: true }
          : texted ? { verdict: "hold", reason: "texted", draft: true } : { verdict: "auto", stored: false };
        it(`${star}★ ${mode} ${label} → ${expected.verdict}${"reason" in expected ? `/${expected.reason}` : ""}`, () => {
          const modes = { ...ALL_APPROVAL, [star]: mode };
          expect(run({ starRating: star, comment }, { modes })).toEqual(expected);
        });
      }
    }
  }

  it("default modes: 4★ and 5★ rating-only auto, 1-3★ held for approval", () => {
    expect(run({ starRating: 5 })).toEqual({ verdict: "auto", stored: false });
    expect(run({ starRating: 4 })).toEqual({ verdict: "auto", stored: false });
    for (const s of [1, 2, 3]) expect(run({ starRating: s })).toMatchObject({ verdict: "hold", reason: "approval" });
  });
});

describe("enabledAt × backlog", () => {
  const cases: Array<[string, number | null, boolean, string]> = [
    ["after enabledAt, backlog off", ENABLED_AT + 1, false, "auto"],
    ["exactly at enabledAt, backlog off", ENABLED_AT, false, "auto"],
    ["before enabledAt, backlog off", ENABLED_AT - 1, false, "skip"],
    ["before enabledAt, backlog on", ENABLED_AT - 30 * DAY, true, "auto"],
    ["after enabledAt, backlog on", ENABLED_AT + 1, true, "auto"],
    ["no createTime, backlog off", null, false, "skip"],
  ];
  it.each(cases)("%s → %s", (_l, createTimeMs, includeBacklog, verdict) => {
    expect(run({ createTimeMs }, { includeBacklog }).verdict).toBe(verdict);
  });

  it("no enabledAt with backlog off skips everything", () => {
    expect(run({}, { enabledAtMs: null })).toEqual({ verdict: "skip", why: "before_enabled" });
  });

  it("a backlog review is still held when texted or approval", () => {
    expect(run({ createTimeMs: 0, comment: "hi" }, { includeBacklog: true })).toMatchObject({ reason: "texted" });
    expect(run({ createTimeMs: 0, starRating: 2 }, { includeBacklog: true })).toMatchObject({ reason: "approval" });
  });
});

describe("caps", () => {
  it("20 posts today → a new auto review is held without a draft (cap)", () => {
    expect(run({}, {}, counts(19))).toEqual({ verdict: "auto", stored: false });
    expect(run({}, {}, counts(20))).toEqual({ verdict: "hold", reason: "cap", draft: false });
  });

  it("40 auto drafts today → held without a draft (no_budget), auto and held alike", () => {
    expect(run({}, {}, counts(0, 39))).toEqual({ verdict: "auto", stored: false });
    expect(run({}, {}, counts(0, 40))).toEqual({ verdict: "hold", reason: "no_budget", draft: false });
    expect(run({ starRating: 1 }, {}, counts(0, 40))).toEqual({ verdict: "hold", reason: "no_budget", draft: false });
    expect(run({ comment: "x" }, {}, counts(0, 40))).toEqual({ verdict: "hold", reason: "no_budget", draft: false });
  });

  it("the post cap does not stop drafting a review a person will post", () => {
    expect(run({ starRating: 2 }, {}, counts(20))).toEqual({ verdict: "hold", reason: "approval", draft: true });
  });
});

describe("skips", () => {
  it.each<[string, Partial<DecideReview>, Partial<DecideSettings>, string]>([
    ["auto-reply off", {}, { enabled: false }, "disabled"],
    ["tombstoned", { state: "removed" }, {}, "tombstoned"],
    ["another listing", { locationName: "locations/other" }, {}, "other_listing"],
    ["no enabled listing", {}, { listingLocationName: null }, "other_listing"],
    ["replied", { hasReply: true }, {}, "replied"],
    ["ever replied (a reply since deleted)", { hadReply: true }, {}, "had_reply"],
    ["a reply in flight", { inFlight: true }, {}, "in_flight"],
    ["auto-replied before", { autoReplied: true }, {}, "auto_replied"],
    ["not seen by this run (stale cache)", { lastSeenAtMs: RUN - 1 }, {}, "not_seen"],
    ["never seen", { lastSeenAtMs: null }, {}, "not_seen"],
    ["stale cache even with backlog on", { lastSeenAtMs: RUN - DAY, createTimeMs: 0 }, { includeBacklog: true }, "not_seen"],
    ["no star rating", { starRating: null }, {}, "no_rating"],
    ["no basis", { basisHash: null }, {}, "no_rating"],
    ["discarded (outside the cache), same basis", { dismissedBasisHash: BASIS }, {}, "dismissed"],
  ])("%s", (_l, r, s, why) => {
    expect(run(r, s)).toEqual({ verdict: "skip", why });
  });

  it("seen exactly at the run's start counts as seen", () => {
    expect(run({ lastSeenAtMs: RUN }).verdict).toBe("auto");
  });

  it("a discard of an older basis does not skip the changed review", () => {
    expect(run({ dismissedBasisHash: "c".repeat(64) }).verdict).toBe("auto");
  });
});

describe("the pendingReply state table", () => {
  it("none → decide from scratch", () => {
    expect(run({ pending: null })).toEqual({ verdict: "auto", stored: false });
  });

  it("auto_queued fresh → post the stored bytes, no new draft", () => {
    expect(run({ pending: pending("auto_queued") })).toEqual({ verdict: "auto", stored: true });
  });

  it("auto_queued fresh at the post cap → wait (keep the bytes)", () => {
    expect(run({ pending: pending("auto_queued") }, {}, counts(20))).toEqual({ verdict: "skip", why: "cap_wait" });
  });

  it("auto_queued stale → drop the bytes, re-decide and re-draft", () => {
    expect(run({ pending: pending("auto_queued", { basisHash: "old" }) })).toEqual({ verdict: "auto", stored: false });
    expect(run({ pending: pending("auto_queued", { basisHash: "old" }), comment: "now texted" })).toMatchObject({ reason: "texted", draft: true });
  });

  it.each(["approval", "texted"] as const)("%s fresh → skip, waits for a human", (reason) => {
    expect(run({ pending: pending(reason) })).toEqual({ verdict: "skip", why: "held" });
  });

  it.each(["approval", "texted"] as const)("%s stale → re-draft, stays held, its reason re-derived", (reason) => {
    // 5★ Auto, rating-only now → held as approval; with text → texted; on an Approval star → approval.
    expect(run({ pending: pending(reason, { basisHash: "old" }) })).toEqual({ verdict: "hold", reason: "approval", draft: true });
    expect(run({ pending: pending(reason, { basisHash: "old" }), comment: "hi" })).toEqual({ verdict: "hold", reason: "texted", draft: true });
    expect(run({ pending: pending(reason, { basisHash: "old" }), comment: "hi", starRating: 2 }))
      .toEqual({ verdict: "hold", reason: "approval", draft: true });
  });

  it("draft_failed fresh → retried only once `at` is 24 h old", () => {
    expect(run({ pending: pending("draft_failed", { atMs: NOW - DAY + 1 }) })).toEqual({ verdict: "skip", why: "draft_retry_wait" });
    expect(run({ pending: pending("draft_failed", { atMs: NOW - DAY }) })).toEqual({ verdict: "auto", stored: false });
  });

  it("draft_failed stale → re-decide", () => {
    expect(run({ pending: pending("draft_failed", { basisHash: "old" }) })).toEqual({ verdict: "auto", stored: false });
  });

  it.each(["no_budget", "cap"] as const)("%s → re-decide (may now auto-post)", (reason) => {
    expect(run({ pending: pending(reason) })).toEqual({ verdict: "auto", stored: false });
    expect(run({ pending: pending(reason, { basisHash: "old" }) })).toEqual({ verdict: "auto", stored: false });
  });

  it("dismissed fresh → skip for good; stale → re-decide", () => {
    expect(run({ pending: pending("dismissed") })).toEqual({ verdict: "skip", why: "dismissed" });
    expect(run({ pending: pending("dismissed", { basisHash: "old" }) })).toEqual({ verdict: "auto", stored: false });
  });

  it("every star in auto mode still holds a stale held draft", () => {
    expect(run({ pending: pending("texted", { basisHash: "old" }) }, { modes: ALL_AUTO })).toMatchObject({ verdict: "hold", reason: "approval" });
  });

  it("post_failed fresh → the stored bytes retried once `at` is 24 h old (within the post cap); stale → re-decide", () => {
    const failed = (o: Partial<DecidePending> = {}) => pending("post_failed", { hasText: true, ...o });
    expect(run({ pending: failed({ atMs: NOW - DAY + 1 }) })).toEqual({ verdict: "skip", why: "post_retry_wait" });
    expect(run({ pending: failed({ atMs: NOW - DAY }) })).toEqual({ verdict: "auto", stored: true });
    expect(run({ pending: failed({ atMs: NOW - DAY }) }, {}, counts(20))).toEqual({ verdict: "skip", why: "cap_wait" });
    expect(run({ pending: failed({ basisHash: "old" }) })).toEqual({ verdict: "auto", stored: false });
  });

  it.each(["auto_queued", "post_failed"] as const)("%s orphaned by an off→on (backlog off, review older) → to_approval", (reason) => {
    const p = pending(reason, { hasText: true });
    expect(run({ pending: p, createTimeMs: ENABLED_AT - 1 })).toEqual({ verdict: "to_approval" });
    const withBacklog = reason === "auto_queued" ? { verdict: "auto", stored: true } : { verdict: "skip", why: "post_retry_wait" };
    expect(run({ pending: p, createTimeMs: ENABLED_AT - 1 }, { includeBacklog: true })).toEqual(withBacklog);
    expect(run({ pending: { ...p, basisHash: "old" }, createTimeMs: ENABLED_AT - 1 })).toEqual({ verdict: "skip", why: "before_enabled" });
  });
});
