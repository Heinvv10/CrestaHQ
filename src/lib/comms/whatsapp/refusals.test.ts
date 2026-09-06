import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WA_REFUSAL_MESSAGES, WA_REFUSAL_STATUS } from "./refusals";

/**
 * The completeness check reads the GO SOURCE, not a hand-copied list.
 *
 * The first version of this test compared the map against a literal in this
 * same file, so adding an eleventh RefusalCode to the bridge failed nothing —
 * it only noticed someone editing the map, which is the change already visible
 * in review. Blind review caught that; its comment claimed to be "the thing
 * that notices when a new rail ships" and it was not.
 */
const RAILS_TYPES = join(
  process.cwd(),
  "services/wa-agent-bridge/rails/types.go",
);

function codesDeclaredByTheBridge(): string[] {
  const src = readFileSync(RAILS_TYPES, "utf8");
  return [...src.matchAll(/RefusalCode\s*=\s*"([a-z_]+)"/g)].map((m) => m[1]!);
}

describe("WhatsApp refusal wording", () => {
  it("reads the bridge's codes at all — the check is worthless otherwise", () => {
    // If the regex or the path ever stops matching, every assertion below
    // passes vacuously against an empty list.
    expect(codesDeclaredByTheBridge().length).toBeGreaterThanOrEqual(10);
  });

  it("has wording for every rail the bridge can refuse with", () => {
    const missing = codesDeclaredByTheBridge().filter(
      (c) => !(c in WA_REFUSAL_MESSAGES),
    );
    expect(missing, "rails with no operator wording").toEqual([]);
  });

  it("invents no code the bridge does not emit", () => {
    const declared = new Set(codesDeclaredByTheBridge());
    const invented = Object.keys(WA_REFUSAL_MESSAGES).filter(
      (c) => !declared.has(c),
    );
    expect(invented, "wording for a rail that does not exist").toEqual([]);
  });

  it("is a conflict, not a bad gateway", () => {
    // 502 says the gateway broke. Nothing broke — the provider declined, and a
    // 5xx invites proxies and retry logic to try again.
    expect(WA_REFUSAL_STATUS).toBe(409);
  });
});

/**
 * No message may state a value the deployment can change.
 *
 * Every quiet-hour bound, budget and session window in the bridge is
 * configurable — globally, and several of them per consumer. A message naming
 * "21:00-07:00" is right on the default deployment and wrong everywhere else,
 * and an operator cannot tell which. This is the one property of the wording
 * worth asserting; the earlier "tells the operator what to do" checks asserted
 * nothing and passed against forty-five letter As.
 */
describe("refusal wording states nothing configurable", () => {
  it("names no clock time", () => {
    for (const [code, msg] of Object.entries(WA_REFUSAL_MESSAGES)) {
      expect(msg, `${code} names a clock time`).not.toMatch(/\d{1,2}:\d{2}/);
    }
  });

  it("promises no fixed reset moment", () => {
    // Every cap in the bridge is a ROLLING window, so "at midnight", "on the
    // hour" and "tomorrow" are all wrong, and send an operator away to wait
    // for a boundary that never arrives.
    for (const [code, msg] of Object.entries(WA_REFUSAL_MESSAGES)) {
      expect(msg, `${code} promises a reset boundary`).not.toMatch(
        /resets? (on the hour|tomorrow|at midnight)/i,
      );
    }
  });
});
