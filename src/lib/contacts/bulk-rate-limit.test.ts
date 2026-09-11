import { describe, expect, it, vi } from "vitest";

import { checkBulkRateLimit } from "./bulk-rate-limit";

describe("checkBulkRateLimit", () => {
  it("allows 30 calls a minute per user, then blocks with a Retry-After", () => {
    for (let i = 0; i < 30; i++) expect(checkBulkRateLimit("u-a").ok).toBe(true);
    const blocked = checkBulkRateLimit("u-a");
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it("keeps users' budgets separate", () => {
    for (let i = 0; i < 31; i++) checkBulkRateLimit("u-b");
    expect(checkBulkRateLimit("u-b").ok).toBe(false);
    expect(checkBulkRateLimit("u-c").ok).toBe(true);
  });

  it("resets after the window", () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 31; i++) checkBulkRateLimit("u-d");
      expect(checkBulkRateLimit("u-d").ok).toBe(false);
      vi.advanceTimersByTime(60_001);
      expect(checkBulkRateLimit("u-d").ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
