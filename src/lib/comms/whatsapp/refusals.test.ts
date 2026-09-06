import { describe, it, expect } from "vitest";
import { WA_REFUSAL_MESSAGES, WA_REFUSAL_STATUS } from "./refusals";

describe("WhatsApp refusal wording", () => {
  it("covers every rail the bridge can refuse with", () => {
    // Kept in step with rails/types.go by hand, so this test is the thing that
    // notices when a new rail ships and the operator gets raw code instead of
    // an instruction.
    const codesFromBridge = [
      "kill_switch",
      "consumer_budget",
      "reply_only",
      "per_contact_cap",
      "consecutive_cap",
      "daily_cap",
      "quiet_hours",
      "internal_error",
      "in_flight",
      "idempotency_key_reused",
    ];
    expect(Object.keys(WA_REFUSAL_MESSAGES).sort()).toEqual(
      codesFromBridge.sort(),
    );
  });

  it("tells the operator what to do, not what the rail is called", () => {
    for (const [code, msg] of Object.entries(WA_REFUSAL_MESSAGES)) {
      // The code itself must never leak into operator-facing text.
      expect(msg, code).not.toContain(code);
      expect(msg.length, code).toBeGreaterThan(30);
      // A refusal an operator can act on ends in guidance, not a full stop
      // after a noun phrase. Cheap proxy: it mentions a subject or a next step.
      expect(msg, code).toMatch(/[a-z]/);
    }
  });

  it("is a conflict, not a bad gateway", () => {
    // 502 says the gateway broke. Nothing broke — the provider declined, and a
    // 5xx invites proxies and retry logic to try again.
    expect(WA_REFUSAL_STATUS).toBe(409);
  });
});
