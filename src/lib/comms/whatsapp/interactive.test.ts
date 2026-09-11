import { describe, expect, it } from "vitest";

import { interactiveFromButtons } from "./interactive";

const YES = { type: "quick_reply" as const, text: "Yes, all good" };
const NO = { type: "quick_reply" as const, text: "No, a problem" };
const REVIEW = { type: "url" as const, text: "Leave a review", url: "https://g.page/r/velocity/review" };

describe("interactiveFromButtons — Meta's in-window rules", () => {
  it("renders quick replies as reply buttons, the text as both id and title", () => {
    expect(interactiveFromButtons("How did it go?", [YES, NO])).toEqual({
      ok: true,
      interactive: {
        type: "button",
        body: { text: "How did it go?" },
        action: {
          buttons: [
            { type: "reply", reply: { id: "Yes, all good", title: "Yes, all good" } },
            { type: "reply", reply: { id: "No, a problem", title: "No, a problem" } },
          ],
        },
      },
    });
  });

  it("renders one link as a cta_url message", () => {
    expect(interactiveFromButtons("Thank you!", [REVIEW])).toEqual({
      ok: true,
      interactive: {
        type: "cta_url",
        body: { text: "Thank you!" },
        action: {
          name: "cta_url",
          parameters: { display_text: "Leave a review", url: "https://g.page/r/velocity/review" },
        },
      },
    });
  });

  it.each([
    ["reply buttons and a link together", [YES, REVIEW], "WA_INTERACTIVE_BUTTONS_UNSUPPORTED"],
    ["two links", [REVIEW, { ...REVIEW, text: "Our site" }], "WA_INTERACTIVE_BUTTONS_UNSUPPORTED"],
    ["a 21-character label (templates allow 25)", [{ type: "quick_reply" as const, text: "No, there's a problem" }], "WA_INTERACTIVE_LABEL_TOO_LONG"],
  ])("refuses %s", (_label, buttons, error) => {
    expect(interactiveFromButtons("Hi", buttons)).toEqual({ ok: false, error });
  });

  it("accepts a 20-character label", () => {
    expect(interactiveFromButtons("Hi", [{ type: "quick_reply", text: "Yes, everything fine" }]).ok).toBe(true);
  });

  it("refuses an empty body and one over 1024 characters", () => {
    expect(interactiveFromButtons("  ", [YES])).toEqual({ ok: false, error: "WA_INTERACTIVE_BODY_INVALID" });
    expect(interactiveFromButtons("x".repeat(1025), [YES])).toEqual({ ok: false, error: "WA_INTERACTIVE_BODY_INVALID" });
    expect(interactiveFromButtons("x".repeat(1024), [YES]).ok).toBe(true);
  });
});
