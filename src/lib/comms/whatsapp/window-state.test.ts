import { describe, expect, it } from "vitest";
import {
  formatWindowLeft,
  latestInboundAt,
  waWindowLabel,
  waWindowState,
} from "./window-state";

const NOW = new Date("2026-09-13T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const H = 3600_000;
const M = 60_000;

describe("waWindowState", () => {
  it("is open with the time left until lastInbound + window", () => {
    const s = waWindowState({ enforcesWindow: true, lastInboundAt: ago(20 * H + 48 * M), now: NOW });
    expect(s).toEqual({
      kind: "open",
      closesAt: new Date(NOW.getTime() + 3 * H + 12 * M),
      msLeft: 3 * H + 12 * M,
    });
    expect(waWindowLabel(s)).toBe("Window open · closes in 3h 12m");
  });

  it("is closed exactly at the boundary and just after (same rule as the server)", () => {
    for (const lastInboundAt of [ago(24 * H), ago(24 * H + 1)]) {
      const s = waWindowState({ enforcesWindow: true, lastInboundAt, now: NOW });
      expect(s).toEqual({ kind: "closed", lastInboundAt });
      expect(waWindowLabel(s)).toBe("Window closed — only an approved template can be sent");
    }
    expect(waWindowState({ enforcesWindow: true, lastInboundAt: ago(24 * H - 1), now: NOW }).kind).toBe("open");
  });

  it("is closed when the contact never messaged in", () => {
    expect(waWindowState({ enforcesWindow: true, lastInboundAt: null, now: NOW })).toEqual({
      kind: "closed",
      lastInboundAt: null,
    });
  });

  it("is exempt on a rail without a window (the bridge), whatever the history", () => {
    for (const lastInboundAt of [null, ago(1 * M), ago(48 * H)]) {
      const s = waWindowState({ enforcesWindow: false, lastInboundAt, now: NOW });
      expect(s).toEqual({ kind: "exempt" });
      expect(waWindowLabel(s)).toBeNull();
    }
  });

  it("honours a custom sessionWindowHours", () => {
    const lastInboundAt = ago(3 * H);
    expect(waWindowState({ enforcesWindow: true, lastInboundAt, now: NOW, windowHours: 2 }).kind).toBe("closed");
    const s = waWindowState({ enforcesWindow: true, lastInboundAt, now: NOW, windowHours: 4 });
    expect(s).toMatchObject({ kind: "open", msLeft: 1 * H });
  });

  it("defaults to 24 hours", () => {
    expect(waWindowState({ enforcesWindow: true, lastInboundAt: ago(23 * H), now: NOW })).toMatchObject({
      kind: "open",
      msLeft: 1 * H,
    });
  });
});

describe("formatWindowLeft", () => {
  it("rounds down to the minute", () => {
    expect(formatWindowLeft(3 * H + 12 * M + 59_999)).toBe("3h 12m");
    expect(formatWindowLeft(2 * H)).toBe("2h 0m");
    expect(formatWindowLeft(45 * M + 30_000)).toBe("45m");
    expect(formatWindowLeft(59_999)).toBe("<1m");
  });
});

describe("latestInboundAt", () => {
  const ts = (d: Date) => ({ toDate: () => d });
  it("takes the first inbound row of a newest-first list", () => {
    const newer = ago(1 * H);
    const older = ago(5 * H);
    expect(
      latestInboundAt([
        { direction: "outbound", createdAt: ts(ago(0)) },
        { direction: "inbound", createdAt: ts(newer) },
        { direction: "inbound", createdAt: ts(older) },
      ]),
    ).toEqual(newer);
  });
  it("is null with no inbound row, or an inbound row without a time", () => {
    expect(latestInboundAt([{ direction: "outbound", createdAt: ts(NOW) }])).toBeNull();
    expect(latestInboundAt([{ direction: "inbound", createdAt: null }])).toBeNull();
    expect(latestInboundAt([])).toBeNull();
  });
});
