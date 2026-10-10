import { expect, it } from "vitest";
import { resolveMetadataBase } from "./metadata-base";

it("uses a valid app URL as the origin", () => {
  expect(resolveMetadataBase("https://crm.example.com").origin).toBe("https://crm.example.com");
  expect(resolveMetadataBase("  https://crm.example.com/  ").href).toBe("https://crm.example.com/");
});

it("returns undefined (Next default) on missing, empty or malformed values", () => {
  for (const bad of [undefined, "", "   ", "crm.example.com", "not a url", "//crm.example.com"]) {
    expect(resolveMetadataBase(bad)).toBeUndefined();
  }
});

it("rejects non-http(s) schemes", () => {
  expect(resolveMetadataBase("javascript:alert(1)")).toBeUndefined();
  expect(resolveMetadataBase("ftp://crm.example.com")).toBeUndefined();
});
