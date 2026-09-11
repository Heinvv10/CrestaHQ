import { describe, expect, it } from "vitest";
import { deriveHealth } from "./health";
import type { GbpSummary } from "./types";

/** Freshness must be honest: the UI shows exactly what this returns. */

const NOW = new Date("2026-09-11T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

function summary(over: Partial<GbpSummary> = {}): GbpSummary {
  return {
    locationName: "locations/l1",
    averageRating: 4.2,
    totalReviewCount: 10,
    lastSuccessfulSyncAt: hoursAgo(1),
    lastRunAt: hoursAgo(1),
    lastRunStatus: "success",
    lastErrorKind: null,
    health: "ok",
    ...over,
  };
}

describe("deriveHealth", () => {
  it("is never_synced without a summary", () => {
    expect(deriveHealth(null, NOW)).toBe("never_synced");
    expect(deriveHealth(undefined, NOW)).toBe("never_synced");
  });

  it("is ok after a recent success", () => {
    expect(deriveHealth(summary(), NOW)).toBe("ok");
  });

  it("goes stale after two missed cadences (12h) even when the last run said success", () => {
    expect(deriveHealth(summary({ lastSuccessfulSyncAt: hoursAgo(11.9) }), NOW)).toBe("ok");
    expect(deriveHealth(summary({ lastSuccessfulSyncAt: hoursAgo(12.1) }), NOW)).toBe("stale");
  });

  it("maps a partial last run to partial", () => {
    expect(deriveHealth(summary({ lastRunStatus: "partial" }), NOW)).toBe("partial");
  });

  it("maps a failed run to stale while the last success is within 30 days, else error", () => {
    expect(deriveHealth(summary({ lastRunStatus: "failed", lastSuccessfulSyncAt: hoursAgo(2) }), NOW)).toBe("stale");
    expect(
      deriveHealth(summary({ lastRunStatus: "failed", lastSuccessfulSyncAt: hoursAgo(24 * 31) }), NOW),
    ).toBe("error");
    expect(deriveHealth(summary({ lastRunStatus: "failed", lastSuccessfulSyncAt: null }), NOW)).toBe("error");
  });

  it("maps a reconnect-required run (or a skipped one for that reason) to reconnect_required", () => {
    expect(deriveHealth(summary({ lastRunStatus: "reconnect_required" }), NOW)).toBe("reconnect_required");
    expect(
      deriveHealth(summary({ lastRunStatus: "skipped", lastErrorKind: "reconnect_required" }), NOW),
    ).toBe("reconnect_required");
  });

  it("is error once the last success is older than 30 days, or retention expired", () => {
    expect(deriveHealth(summary({ lastSuccessfulSyncAt: hoursAgo(24 * 30 + 1) }), NOW)).toBe("error");
    expect(deriveHealth(summary({ lastErrorKind: "retention_expired" }), NOW)).toBe("error");
  });

  it("accepts Firestore Timestamp-like values", () => {
    const ts = { toMillis: () => hoursAgo(1).getTime() } as unknown as Date;
    expect(deriveHealth(summary({ lastSuccessfulSyncAt: ts }), NOW)).toBe("ok");
  });
});
