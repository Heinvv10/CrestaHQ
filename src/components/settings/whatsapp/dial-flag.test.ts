import { describe, expect, it } from "vitest";
import { flagForDisplayNumber } from "./dial-flag";

describe("flagForDisplayNumber", () => {
  it("maps the recorded Velocity number to South Africa", () => {
    expect(flagForDisplayNumber("+27 67 147 7116")).toBe("🇿🇦");
  });

  it("maps +1 to the US flag", () => {
    expect(flagForDisplayNumber("+1 415 555 0100")).toBe("🇺🇸");
  });

  it("prefers the longest prefix — +77 is Kazakhstan inside Russia's +7", () => {
    expect(flagForDisplayNumber("+7 495 123 4567")).toBe("🇷🇺");
    expect(flagForDisplayNumber("+7 701 123 4567")).toBe("🇰🇿");
    expect(flagForDisplayNumber("+7 601 123 4567")).toBe("🇰🇿"); // +7 6xx is Kazakhstan too
  });

  it("prefers the longest prefix — +971 is the UAE, not +9-anything", () => {
    expect(flagForDisplayNumber("+971 50 123 4567")).toBe("🇦🇪");
    expect(flagForDisplayNumber("+254 700 000000")).toBe("🇰🇪");
    expect(flagForDisplayNumber("+95 555")).toBeNull(); // neither "9" nor "95" is listed
  });

  it("returns null for unknown, empty and null input", () => {
    expect(flagForDisplayNumber("+999 1")).toBeNull();
    expect(flagForDisplayNumber("")).toBeNull();
    expect(flagForDisplayNumber("no digits")).toBeNull();
    expect(flagForDisplayNumber(null)).toBeNull();
  });
});
