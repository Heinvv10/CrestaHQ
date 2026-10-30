import { describe, expect, it } from "vitest";
import { resolveSafeFormRedirect } from "./public-form";

/**
 * Tests the exact seam `handleSubmit` navigates through
 * (`window.location.href = resolveSafeFormRedirect(data.redirectUrl)`), not
 * just the shared `isSafeFormRedirectUrl` helper in isolation — a form
 * whose settings.redirectUrl carries a `javascript:` value (writable via
 * direct client-SDK Firestore writes) must never produce a navigable URL
 * here.
 */
describe("resolveSafeFormRedirect", () => {
  it("returns an https redirectUrl unchanged", () => {
    expect(resolveSafeFormRedirect("https://example.com/thanks")).toBe(
      "https://example.com/thanks",
    );
  });

  it("returns null for a javascript: redirectUrl", () => {
    expect(resolveSafeFormRedirect("javascript:alert(document.cookie)")).toBeNull();
  });

  it("returns null for absent or empty redirectUrl", () => {
    expect(resolveSafeFormRedirect(null)).toBeNull();
    expect(resolveSafeFormRedirect(undefined)).toBeNull();
    expect(resolveSafeFormRedirect("")).toBeNull();
  });

  it("passes a relative path and refuses protocol-relative ones", () => {
    expect(resolveSafeFormRedirect("/thanks")).toBe("/thanks");
    expect(resolveSafeFormRedirect("//evil.com")).toBeNull();
    expect(resolveSafeFormRedirect("/\\evil.com")).toBeNull();
  });
});
