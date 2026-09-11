import { describe, expect, it } from "vitest";
import { contactDisplayName } from "./display-name";

describe("contactDisplayName", () => {
  it("prefers the name", () => {
    expect(
      contactDisplayName({ name: "Thandi", phone: "+27821234567", email: "t@x.za" })
    ).toBe("Thandi");
  });

  it("falls back to phone when the name is empty or whitespace", () => {
    expect(contactDisplayName({ name: "", phone: "+27821234567" })).toBe(
      "+27821234567"
    );
    expect(
      contactDisplayName({ name: "  ", phone: "+27821234567", email: "t@x.za" })
    ).toBe("+27821234567");
  });

  it("falls back to email when name and phone are empty", () => {
    expect(contactDisplayName({ name: "", phone: "", email: "t@x.za" })).toBe(
      "t@x.za"
    );
  });

  it("uses the placeholder when nothing is set", () => {
    expect(contactDisplayName({})).toBe("Unnamed");
    expect(contactDisplayName({ name: null, phone: null }, "Unnamed contact")).toBe(
      "Unnamed contact"
    );
  });
});
