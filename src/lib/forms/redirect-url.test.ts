import { describe, expect, it } from "vitest";
import { isSafeFormRedirectTarget, isSafeFormRedirectUrl } from "./redirect-url";

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

describe("isSafeFormRedirectTarget", () => {
  it("accepts same-origin relative paths and absolute http(s)", () => {
    for (const ok of ["/thanks", "/thanks?a=1#x", "/", "https://example.com/t"]) {
      expect(isSafeFormRedirectTarget(ok), ok).toBe(true);
    }
  });

  it("refuses protocol-relative, backslash, control and whitespace tricks", () => {
    for (const bad of [
      "//evil.com",
      "///evil.com",
      "/\\evil.com",
      "/a\\b",
      "/\t/evil.com",
      "/\n/evil.com",
      "/\u0000/evil.com",
      "/ /evil.com",
      "\t//evil.com",
      " /thanks",
      "%2F%2Fevil.com",
      "javascript:alert(1)",
      "data:text/html,x",
      "thanks",
      "",
    ]) {
      expect(isSafeFormRedirectTarget(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("leaves the absolute-only guard (booking) refusing relative paths", () => {
    expect(isSafeFormRedirectUrl("/thanks")).toBe(false);
  });
});
