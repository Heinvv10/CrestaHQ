import { describe, expect, it } from "vitest";
import { safeRedirect } from "./safe-redirect";

/**
 * `?redirect` is attacker-supplied: /login is a public path, so anyone can send
 * a victim `https://crm.crestahq.com/login?redirect=…`.
 *
 * The control-character cases are the ones that matter. WHATWG strips ASCII
 * tab/LF/CR before parsing, so they defeat any prefix check — all five passed
 * the first version of this guard and resolved to https://evil.com.
 */
const ORIGIN = "https://crm.crestahq.com";
const resolves = (v: string) => new URL(safeRedirect(v), `${ORIGIN}/login`).origin;

describe("safeRedirect", () => {
  it("keeps ordinary in-app paths, with query and hash", () => {
    expect(safeRedirect("/agency")).toBe("/agency");
    expect(safeRedirect("/sa/abc/contacts?tab=1")).toBe("/sa/abc/contacts?tab=1");
    expect(safeRedirect("/agency#top")).toBe("/agency#top");
  });

  it("refuses control-character smuggling that defeats prefix checks", () => {
    for (const attack of [
      "/\t/evil.com",
      "/\n/evil.com",
      "/\r/evil.com",
      "/\t\\evil.com",
      "/\t//evil.com",
    ]) {
      expect(safeRedirect(attack), attack).toBe("/dashboard");
      expect(resolves(attack), attack).toBe(ORIGIN);
    }
  });

  it("refuses protocol-relative and backslash escapes", () => {
    for (const attack of ["//evil.com", "//evil.com/steal", "/\\evil.com"]) {
      expect(safeRedirect(attack), attack).toBe("/dashboard");
      expect(resolves(attack), attack).toBe(ORIGIN);
    }
  });

  it("refuses absolute URLs and non-http schemes", () => {
    for (const attack of [
      "https://evil.com",
      "HTTPS://evil.com",
      "http://evil.com/x",
      "javascript:alert(1)",
      "data:text/html,x",
    ]) {
      expect(safeRedirect(attack), attack).toBe("/dashboard");
      expect(resolves(attack), attack).toBe(ORIGIN);
    }
  });

  it("falls back when absent or empty", () => {
    expect(safeRedirect(null)).toBe("/dashboard");
    expect(safeRedirect(undefined)).toBe("/dashboard");
    expect(safeRedirect("")).toBe("/dashboard");
  });
});
