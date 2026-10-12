import { describe, expect, it } from "vitest";
import { COMMUNITY_DEFAULT_BRAND, communityBrand } from "./community-shell";

/**
 * A community group's brand colour on its public pages (/c). The save route
 * stores whatever was typed, so the value is checked where it is read.
 */
describe("communityBrand", () => {
  it("uses a stored hex, trimmed, 6-digit or 3-digit", () => {
    expect(communityBrand({ brandColor: "#0EA5E9" })).toBe("#0EA5E9");
    expect(communityBrand({ brandColor: "  #f50 " })).toBe("#f50");
  });

  it.each([
    ["extra CSS declarations", "red;position:fixed;inset:0;background:url(https://evil.example/x)"],
    ["a hex followed by more CSS", "#0ea5e9;background:url(https://evil.example/x)"],
    ["a CSS function", "url(https://evil.example/x)"],
    ["a colour name", "red"],
    ["empty", ""],
    ["null", null],
    ["a non-string", ["#aabbcc"]],
  ])("falls back to the default for a stored value that is %s", (_label, brandColor) => {
    expect(communityBrand({ brandColor })).toBe(COMMUNITY_DEFAULT_BRAND);
  });

  it("falls back for a group with no colour", () => {
    expect(communityBrand({})).toBe(COMMUNITY_DEFAULT_BRAND);
  });
});
