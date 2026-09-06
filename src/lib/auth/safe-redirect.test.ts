import { describe, expect, it } from "vitest";
import { safeRedirect } from "./safe-redirect";

/**
 * `?redirect` is attacker-supplied: /login is a public path, so anyone can send
 * a victim `https://crm.crestahq.com/login?redirect=//evil.com`. Before this
 * guard the value went straight to `router.push`.
 */
describe("safeRedirect", () => {
  it("keeps an ordinary in-app path", () => {
    expect(safeRedirect("/agency")).toBe("/agency");
    expect(safeRedirect("/sa/abc/contacts?tab=1")).toBe("/sa/abc/contacts?tab=1");
  });

  it("refuses protocol-relative and scheme-relative escapes", () => {
    expect(safeRedirect("//evil.com")).toBe("/dashboard");
    expect(safeRedirect("//evil.com/steal")).toBe("/dashboard");
    expect(safeRedirect("/\\evil.com")).toBe("/dashboard");
  });

  it("refuses absolute URLs to another origin", () => {
    expect(safeRedirect("https://evil.com")).toBe("/dashboard");
    expect(safeRedirect("http://evil.com/x")).toBe("/dashboard");
    expect(safeRedirect("javascript:alert(1)")).toBe("/dashboard");
  });

  it("falls back when absent or empty", () => {
    expect(safeRedirect(null)).toBe("/dashboard");
    expect(safeRedirect("")).toBe("/dashboard");
  });
});
