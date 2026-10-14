import { describe, expect, it } from "vitest";
import { isHexColor } from "./hex-color";

describe("isHexColor", () => {
  it("admits #RRGGBB, and #RGB only when asked", () => {
    expect(isHexColor("#B13F2B")).toBe(true);
    expect(isHexColor("#abc")).toBe(false);
    expect(isHexColor("#abc", true)).toBe(true);
  });

  it("rejects anything that could carry more than a colour into a style attribute", () => {
    for (const v of ["red", "#12345", "#1234567", "#ggg", " #abcdef", "#abcdef;background:url(x)", "url(#abc)", null, 0x123456, {}]) {
      expect(isHexColor(v, true)).toBe(false);
    }
  });
});
