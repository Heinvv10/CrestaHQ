import { describe, expect, it } from "vitest";
import { pointsAtUploadedLogo } from "./logo-shared";

describe("pointsAtUploadedLogo (Remove's match, server and card)", () => {
  it("matches this tenant's path on any origin", () => {
    expect(pointsAtUploadedLogo("https://old-host.example.org/api/brand/logo/sa/sa1?v=1", "sa", "sa1")).toBe(true);
    expect(pointsAtUploadedLogo("https://crm.example.com/api/brand/logo/sa/sa1", "sa", "sa1")).toBe(true);
  });

  it.each([
    ["another tenant's path", "https://crm.example.com/api/brand/logo/sa/sa2?v=1"],
    ["an id with our id as a prefix", "https://crm.example.com/api/brand/logo/sa/sa10?v=1"],
    ["our path behind a query on another page", "https://crm.example.com/l/x?r=/api/brand/logo/sa/sa1"],
    ["the other scope", "https://crm.example.com/api/brand/logo/agency/sa1?v=1"],
    ["the prefix in a query", "https://cdn.example.com/x.png?r=/api/brand/logo/sa/sa1"],
    ["a longer path", "https://crm.example.com/api/brand/logo/sa/sa1/x"],
    ["not absolute", "/api/brand/logo/sa/sa1"],
    ["empty", ""],
  ])("refuses %s", (_label, url) => {
    expect(pointsAtUploadedLogo(url, "sa", "sa1")).toBe(false);
  });
});
