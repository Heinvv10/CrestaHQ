import { describe, expect, it } from "vitest";

import { minCardChargeGapMs } from "./charge-gap";

const DAY = 86_400_000;

describe("minCardChargeGapMs", () => {
  it.each([
    [{ unit: "week", interval: 1 }, 7 * DAY - DAY / 2],
    [{ unit: "week", interval: 2 }, 14 * DAY - DAY / 2],
    [{ unit: "month", interval: 1 }, 26 * DAY],
    [{ unit: "month", interval: 2 }, 54 * DAY],
    [{ unit: "quarter", interval: 1 }, 82 * DAY],
    [{ unit: "year", interval: 1 }, 334 * DAY],
  ] as const)("%o → %d ms", (cadence, gap) => {
    expect(minCardChargeGapMs(cadence)).toBe(gap);
  });

  it("the shortest real month (28 Feb after a 31st anchor) clears the gap", () => {
    expect(28 * DAY).toBeGreaterThanOrEqual(minCardChargeGapMs({ unit: "month", interval: 1 }));
  });

  it("a nonsense interval counts as 1", () => {
    expect(minCardChargeGapMs({ unit: "month", interval: 0 })).toBe(26 * DAY);
  });
});
