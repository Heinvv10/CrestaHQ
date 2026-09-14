import { describe, expect, it } from "vitest";
import { getStarterTemplate } from "@/lib/comms/whatsapp/starter-templates";
import { askOutcomeOf, failureKindOf, isReviewAsk } from "./review-ask";

/**
 * SP5 d1 — what makes an outbound message a review ask. The senders that use
 * this are tested at their own seams (review-ask-logging.test.ts and the
 * route tests); this pins the rule itself.
 */

const URL = "https://g.page/r/acme/review";

describe("isReviewAsk", () => {
  it("is a review ask when any rendered part contains the configured URL", () => {
    expect(isReviewAsk(URL, ["Hi Jane", `Leave us a review: ${URL}`])).toBe(true);
    expect(isReviewAsk(URL, [null, undefined, `${URL}?utm=sms`])).toBe(true);
  });

  it("is not one without the URL, or when no URL is configured", () => {
    expect(isReviewAsk(URL, ["Your install is booked for Tuesday."])).toBe(false);
    expect(isReviewAsk(null, [`Leave us a review: ${URL}`])).toBe(false);
    expect(isReviewAsk("", [""])).toBe(false);
  });

  it("the review_request starter template is always a review ask", () => {
    const starter = getStarterTemplate("review_request")!;
    expect(isReviewAsk(null, [], { name: "review_request", body: "edited wording {{1}}" })).toBe(true);
    expect(isReviewAsk(null, [], { name: "renamed_tpl", body: starter.body })).toBe(true);
    expect(isReviewAsk(null, [], { name: "lead_acknowledgement", body: "Hi {{1}}" })).toBe(false);
  });
});

describe("failureKindOf / askOutcomeOf", () => {
  it("keeps machine kinds and drops free text (which can quote a phone number)", () => {
    expect(failureKindOf("carrier_unsubscribed")).toBe("carrier_unsubscribed");
    expect(failureKindOf("WA_TEMPLATE_VARIABLE_EMPTY")).toBe("WA_TEMPLATE_VARIABLE_EMPTY");
    expect(failureKindOf("The 'To' number +15005550001 is not valid")).toBe("send_failed");
    expect(failureKindOf(undefined)).toBe("send_failed");
  });

  it("maps a conversation-send outcome: a refusal is a failed ask only after a provider attempt", () => {
    expect(askOutcomeOf({ ok: true, messageId: "SM9", response: {} })).toEqual({ ok: true, messageSid: "SM9" });
    expect(askOutcomeOf({ ok: false, status: 400, error: "x", code: "text_too_long", attempted: true })).toEqual({ ok: false, failureKind: "text_too_long" });
    expect(askOutcomeOf({ ok: false, status: 502, error: "x", outcomeUnknown: true, attempted: true })).toEqual({ ok: false, failureKind: "outcome_unknown" });
    expect(askOutcomeOf({ ok: false, status: 502, error: "x", attempted: true })).toEqual({ ok: false, failureKind: "send_failed" });
    // Refused before anything was sent (opt-out, no phone, quota, gate, window, a rail's refusal): no row.
    expect(askOutcomeOf({ ok: false, status: 409, error: "x", code: "session_window_closed" })).toBeNull();
    expect(askOutcomeOf({ ok: false, status: 429, error: "x" })).toBeNull();
    expect(askOutcomeOf({ ok: false, status: 400, error: "x" })).toBeNull();
  });
});
