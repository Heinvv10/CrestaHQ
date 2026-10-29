import { beforeEach, vi } from "vitest";

/**
 * The Slack test-post cooldown (5 s per sub-account) is module state that
 * outlives a test. This skews `Date.now` so every test starts past every
 * earlier claim, and `pastCooldown()` jumps a test past its own. Time still
 * flows; only an offset is added.
 */
export function skewClockPastSlackCooldown(): { pastCooldown: () => void } {
  const realNow = Date.now.bind(Date);
  let skew = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  beforeEach(() => {
    skew += 10_000;
  });
  return {
    pastCooldown: () => {
      skew += 6_000;
    },
  };
}
