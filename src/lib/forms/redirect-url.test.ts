import { describe, expect, it } from "vitest";
import { isSafeFormRedirectUrl } from "./redirect-url";

/**
 * `forms.settings.redirectUrl` is written via direct client-SDK calls
 * (no server PATCH route validates it) and is navigated to verbatim by the
 * public form page (`window.location.href = data.redirectUrl`). A
 * `javascript:` value would run on the CRM origin when the form is
 * submitted — only absolute http(s) URLs may pass.
 */
describe("isSafeFormRedirectUrl", () => {
  it("accepts absolute http and https URLs", () => {
    expect(isSafeFormRedirectUrl("https://example.com/thanks")).toBe(true);
    expect(isSafeFormRedirectUrl("http://example.com/thanks")).toBe(true);
  });

  it("rejects javascript:, data: and other dangerous schemes", () => {
    for (const bad of [
      "javascript:alert(document.cookie)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
    ]) {
      expect(isSafeFormRedirectUrl(bad), bad).toBe(false);
    }
  });

  it("rejects empty and unparsable values", () => {
    expect(isSafeFormRedirectUrl("")).toBe(false);
    expect(isSafeFormRedirectUrl("not a url")).toBe(false);
  });
});
