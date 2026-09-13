import { describe, expect, it } from "vitest";
import {
  assertWriteMatchesApprovedReport,
  buildConversationPreview,
  classifyContactLookupStatus,
  decideConversationAdvance,
  parseArgs,
} from "./ghl-wa-backfill-guards";

describe("parseArgs", () => {
  it("parses a plain dry run with no flags", () => {
    expect(parseArgs([])).toEqual({ out: null, write: false, confirm: null, approvedReport: null });
  });

  it("parses --out, --write, --confirm, --approved-report together", () => {
    expect(parseArgs(["--out", "/tmp/r.json", "--write", "--confirm", "12", "--approved-report", "/tmp/a.json"])).toEqual({
      out: "/tmp/r.json",
      write: true,
      confirm: 12,
      approvedReport: "/tmp/a.json",
    });
  });

  it("accepts 0 as a valid --confirm value", () => {
    expect(parseArgs(["--confirm", "0"]).confirm).toBe(0);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown flag/);
  });

  it("rejects a value-flag with no value at all", () => {
    expect(() => parseArgs(["--confirm"])).toThrow(/requires a value/);
  });

  it("rejects a value-flag whose 'value' is actually another flag", () => {
    expect(() => parseArgs(["--confirm", "--write"])).toThrow(/requires a value/);
  });

  it("rejects an empty or whitespace-only --confirm", () => {
    expect(() => parseArgs(["--confirm", ""])).toThrow(/non-negative integer/);
    expect(() => parseArgs(["--confirm", "   "])).toThrow(/non-negative integer/);
  });

  it("rejects a non-integer or negative --confirm", () => {
    expect(() => parseArgs(["--confirm", "12.5"])).toThrow(/non-negative integer/);
    expect(() => parseArgs(["--confirm", "-1"])).toThrow(/non-negative integer/);
    expect(() => parseArgs(["--confirm", "abc"])).toThrow(/non-negative integer/);
    expect(() => parseArgs(["--confirm", " 12"])).toThrow(/non-negative integer/);
  });
});

describe("classifyContactLookupStatus", () => {
  it("classifies 404 as not_found", () => {
    expect(classifyContactLookupStatus(404)).toBe("not_found");
  });

  it("classifies every other status, and a null (transport failure) status, as abort", () => {
    expect(classifyContactLookupStatus(401)).toBe("abort");
    expect(classifyContactLookupStatus(500)).toBe("abort");
    expect(classifyContactLookupStatus(null)).toBe("abort");
  });
});

describe("assertWriteMatchesApprovedReport", () => {
  it("throws when --confirm is absent", () => {
    expect(() => assertWriteMatchesApprovedReport(["a", "b"], ["a", "b"], null)).toThrow(/requires --confirm/);
  });

  it("throws when --confirm does not match the fresh count", () => {
    expect(() => assertWriteMatchesApprovedReport(["a", "b"], ["a", "b"], 1)).toThrow(/does not match/);
  });

  it("throws when the fresh set has a message the approved report didn't", () => {
    expect(() => assertWriteMatchesApprovedReport(["a", "b", "c"], ["a", "b"], 3)).toThrow(/new since approval/);
  });

  it("throws when the approved set has a message no longer missing", () => {
    expect(() => assertWriteMatchesApprovedReport(["a"], ["a", "b"], 1)).toThrow(/no longer missing/);
  });

  it("passes when the count matches AND the sets are exactly equal (order-independent)", () => {
    expect(() => assertWriteMatchesApprovedReport(["b", "a"], ["a", "b"], 2)).not.toThrow();
  });
});

describe("buildConversationPreview", () => {
  it("passes short bodies through unchanged", () => {
    expect(buildConversationPreview("hi")).toBe("hi");
  });

  it("truncates at 120 chars with an ellipsis, matching conversations-service.ts", () => {
    const body = "x".repeat(150);
    const preview = buildConversationPreview(body);
    expect(preview).toBe(`${"x".repeat(120)}…`);
  });

  it("does not truncate a body of exactly 120 chars", () => {
    const body = "x".repeat(120);
    expect(buildConversationPreview(body)).toBe(body);
  });
});

describe("decideConversationAdvance", () => {
  const base = {
    currentLastMessageAtMs: 1000,
    watchdogAlertedAtMs: null as number | null,
    watchdogActive: false,
    newestMissingMs: 2000,
    newestMissingDirection: "inbound" as const,
  };

  it("refuses when the backfilled message is not newer than the current lastMessageAt", () => {
    expect(decideConversationAdvance({ ...base, newestMissingMs: 1000 })).toEqual({
      advance: false,
      reason: "not_newer",
    });
    expect(decideConversationAdvance({ ...base, newestMissingMs: 500 })).toEqual({
      advance: false,
      reason: "not_newer",
    });
  });

  it("always advances when there is no current lastMessageAt at all", () => {
    expect(decideConversationAdvance({ ...base, currentLastMessageAtMs: null, newestMissingMs: 1 }).advance).toBe(true);
  });

  it("advances freely when the watchdog is inactive", () => {
    expect(decideConversationAdvance({ ...base, watchdogActive: false })).toEqual({
      advance: true,
      reason: "not_currently_active",
    });
  });

  it("refuses to advance when the watchdog is active and no alert covers the new timestamp", () => {
    expect(decideConversationAdvance({ ...base, watchdogActive: true, watchdogAlertedAtMs: null })).toEqual({
      advance: false,
      reason: "would_arm_watchdog",
    });
    expect(
      decideConversationAdvance({ ...base, watchdogActive: true, watchdogAlertedAtMs: 1500, newestMissingMs: 2000 }),
    ).toEqual({ advance: false, reason: "would_arm_watchdog" });
  });

  it("advances when the watchdog is active but an existing alert already covers the new timestamp", () => {
    expect(
      decideConversationAdvance({ ...base, watchdogActive: true, watchdogAlertedAtMs: 2000, newestMissingMs: 2000 }),
    ).toEqual({ advance: true, reason: "already_covered_by_alert" });
    expect(
      decideConversationAdvance({ ...base, watchdogActive: true, watchdogAlertedAtMs: 5000, newestMissingMs: 2000 }),
    ).toEqual({ advance: true, reason: "already_covered_by_alert" });
  });
});
