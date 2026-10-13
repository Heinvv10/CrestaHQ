import { describe, expect, it } from "vitest";
import { appearanceStyle, resolveAppearance } from "@/lib/forms/appearance";

/**
 * The accent of a public form (/f): it goes into the page's CSS variables,
 * so a stored value is used only when it is a plain hex.
 */

const settings = (accent: unknown) => ({ appearance: { theme: "light", accent, hideChrome: false, hideTitle: false } }) as never;
const vars = (accent: unknown, params: Record<string, string> = {}) =>
  appearanceStyle(resolveAppearance(params, settings(accent))) as Record<string, string>;

describe("a public form's accent", () => {
  it("uses a stored hex, 6-digit or 3-digit", () => {
    expect(vars("#0ea5e9")).toMatchObject({ "--primary": "#0ea5e9", "--ring": "#0ea5e9" });
    expect(vars("#f50")["--primary"]).toBe("#f50");
  });

  it.each([
    ["extra CSS declarations", "red;position:fixed;inset:0;background:url(https://evil.example/x)"],
    ["a hex followed by more CSS", "#0ea5e9;background:url(https://evil.example/x)"],
    ["a CSS function", "url(https://evil.example/x)"],
    ["a colour name", "red"],
    ["a non-string", ["#aabbcc"]],
    ["missing", undefined],
  ])("replaces a stored accent that is %s with the default", (_label, accent) => {
    expect(vars(accent)).toMatchObject({ "--primary": "#7c3aed", "--ring": "#7c3aed" });
    expect(JSON.stringify(vars(accent))).not.toMatch(/evil\.example|#aabbcc/);
    expect(JSON.stringify(vars(accent, { theme: "dark" }))).not.toMatch(/evil\.example|#aabbcc/);
  });

  it("still lets the URL's accent win, and still ignores a bad one", () => {
    expect(vars("#0ea5e9", { accent: "22c55e" })["--primary"]).toBe("#22c55e");
    expect(vars("#0ea5e9", { accent: "red;x" })["--primary"]).toBe("#0ea5e9");
  });
});
