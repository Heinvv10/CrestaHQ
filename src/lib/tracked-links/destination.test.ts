import { describe, expect, it } from "vitest";

import { normalizeDestinationUrl } from "./destination";

/**
 * The redirect route 302s to whatever this returns. Anything that isn't an
 * absolute http(s) URL must come back null, or `/l/{id}` becomes an open
 * redirect wearing our domain.
 */
describe("normalizeDestinationUrl", () => {
  it("accepts absolute http and https URLs", () => {
    expect(normalizeDestinationUrl("https://example.com/report")).toBe(
      "https://example.com/report",
    );
    expect(normalizeDestinationUrl("  http://example.com  ")).toBe(
      "http://example.com/",
    );
  });

  it("rejects every non-http(s) scheme", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "ftp://example.com/x",
      "file:///etc/passwd",
      "mailto:someone@example.com",
    ]) {
      expect(normalizeDestinationUrl(bad), bad).toBeNull();
    }
  });

  it("rejects relative paths, blanks and non-strings", () => {
    for (const bad of ["", "   ", "/report", "example.com", null, 42, {}]) {
      expect(normalizeDestinationUrl(bad), String(bad)).toBeNull();
    }
  });

  it("rejects an absurdly long URL", () => {
    expect(
      normalizeDestinationUrl(`https://example.com/${"x".repeat(2100)}`),
    ).toBeNull();
  });
});
