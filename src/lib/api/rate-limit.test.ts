import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  checkAndCount,
  resolveRateLimitPerMinute,
  snapshotRemaining,
} from "@/lib/api/rate-limit";

describe("resolveRateLimitPerMinute", () => {
  it.each([undefined, null, 0, -5, 1.5, NaN, "300", {}])(
    "falls back to the scope default for %j",
    (raw) => {
      expect(resolveRateLimitPerMinute(raw)).toBeUndefined();
    },
  );
  it("passes valid integers through, including lowering", () => {
    expect(resolveRateLimitPerMinute(300)).toBe(300);
    expect(resolveRateLimitPerMinute(10)).toBe(10);
  });
  it("clamps above the 600 ceiling", () => {
    expect(resolveRateLimitPerMinute(600)).toBe(600);
    expect(resolveRateLimitPerMinute(100000)).toBe(600);
  });
});

function burst(n: number, opts: Parameters<typeof checkAndCount>[0]) {
  let last = checkAndCount(opts);
  let ok = last.ok ? 1 : 0;
  for (let i = 1; i < n; i++) {
    last = checkAndCount(opts);
    if (last.ok) ok += 1;
  }
  return { ok, last };
}

describe("checkAndCount per-key override", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // A fresh instant per test: buckets are module-level, keys are unique too.
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
  });

  it("override 300 allows 300 in a minute and refuses the 301st", () => {
    const o = { keyId: "k300", mode: "live", scope: "admin", rateLimitPerMinute: 300 } as const;
    const { ok, last } = burst(300, o);
    expect(ok).toBe(300);
    const refused = checkAndCount(o);
    expect(last.ok).toBe(true);
    expect(refused).toMatchObject({ ok: false, window: "minute", limit: 300 });
  });

  it("a key with no override is still refused on the 61st", () => {
    const o = { keyId: "kdefault", mode: "live", scope: "admin" } as const;
    expect(burst(60, o).ok).toBe(60);
    expect(checkAndCount(o)).toMatchObject({ ok: false, window: "minute", limit: 60 });
  });

  it("an invalid override behaves like no override", () => {
    const o = { keyId: "kbad", mode: "live", scope: "admin", rateLimitPerMinute: -1 } as const;
    expect(burst(60, o).ok).toBe(60);
    expect(checkAndCount(o).ok).toBe(false);
  });

  it("another key's budget is unaffected by the raised key", () => {
    const raised = { keyId: "kraised", mode: "live", scope: "admin", rateLimitPerMinute: 300 } as const;
    burst(301, raised);
    const other = { keyId: "kother", mode: "live", scope: "admin" } as const;
    expect(burst(60, other).ok).toBe(60);
    expect(checkAndCount(other).ok).toBe(false);
  });

  it("a raised key is not stopped by the unchanged 1000/hour budget", () => {
    const o = { keyId: "khour", mode: "live", scope: "admin", rateLimitPerMinute: 300 } as const;
    let total = 0;
    for (let m = 0; m < 4; m++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 8, 13, m, 1)));
      total += burst(300, o).ok;
    }
    expect(total).toBe(1200);
  });

  it("a lowered override lowers the minute budget only", () => {
    const o = { keyId: "klow", mode: "live", scope: "admin", rateLimitPerMinute: 5 } as const;
    expect(burst(5, o).ok).toBe(5);
    expect(checkAndCount(o)).toMatchObject({ ok: false, limit: 5 });
  });

  it("snapshotRemaining reports the effective limit", () => {
    const o = { keyId: "ksnap", mode: "live", scope: "admin", rateLimitPerMinute: 300 } as const;
    checkAndCount(o);
    expect(snapshotRemaining(o)).toMatchObject({ limit: 300, remaining: 299 });
    expect(snapshotRemaining({ keyId: "ksnap2", mode: "live", scope: "admin" }).limit).toBe(60);
  });
});
