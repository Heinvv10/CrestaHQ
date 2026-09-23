import { describe, expect, it } from "vitest";
import { shouldRedirectAfterBooking } from "./public-booking-view";

/**
 * Tests the exact seam `ConfirmationPanel` navigates through
 * (`window.location.replace` / the `<a href>`), not just the shared
 * `isSafeFormRedirectUrl` helper in isolation. The book route already
 * sanitises `redirectUrl`, but this is the client's own defense-in-depth
 * layer against a `javascript:`/`data:` value.
 */
describe("shouldRedirectAfterBooking", () => {
  it("redirects a scheduled booking with a safe https redirectUrl", () => {
    expect(
      shouldRedirectAfterBooking({
        status: "scheduled",
        redirectUrl: "https://example.com/thanks",
      }),
    ).toBe(true);
  });

  it("never redirects to a javascript: URL", () => {
    expect(
      shouldRedirectAfterBooking({
        status: "scheduled",
        redirectUrl: "javascript:alert(document.cookie)",
      }),
    ).toBe(false);
  });

  it("never redirects an awaiting-payment hold, even with a safe URL", () => {
    expect(
      shouldRedirectAfterBooking({
        status: "awaiting_payment",
        redirectUrl: "https://example.com/thanks",
      }),
    ).toBe(false);
  });

  it("does not redirect when there is no redirectUrl", () => {
    expect(
      shouldRedirectAfterBooking({ status: "scheduled", redirectUrl: null }),
    ).toBe(false);
  });
});
