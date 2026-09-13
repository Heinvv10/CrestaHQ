import { describe, expect, it } from "vitest";
import { needsPolling } from "./use-scheduled-messages";

const NOW = Date.parse("2026-09-13T10:00:00Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const msg = (status: string, claimOffsetMs: number | null = null) => ({
  status: status as never,
  sendAt: at(-60 * 60_000),
  claimedAt: claimOffsetMs === null ? null : at(claimOffsetMs),
});

describe("needsPolling", () => {
  it("polls while something is pending or freshly sending", () => {
    expect(needsPolling([msg("pending")], NOW)).toBe(true);
    expect(needsPolling([msg("sending", -60_000)], NOW)).toBe(true);
  });

  it("stops for a stale sending item (worker died) and for terminal ones", () => {
    expect(needsPolling([msg("sending", -16 * 60_000)], NOW)).toBe(false);
    expect(needsPolling([msg("failed"), msg("unconfirmed"), msg("sent")], NOW)).toBe(false);
  });
});
