import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isUploadedLogoUrl, pointsAtUploadedLogo } from "./logo-shared";

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.example.com/"));
afterEach(() => vi.unstubAllEnvs());

it("matches this tenant's own uploaded logo, any version", () => {
  expect(isUploadedLogoUrl("https://crm.example.com/api/brand/logo/sa/sa1?v=17", "sa", "sa1")).toBe(true);
  expect(isUploadedLogoUrl("https://crm.example.com/api/brand/logo/agency/ag1", "agency", "ag1")).toBe(true);
});

it.each([
  ["another tenant's logo", "https://crm.example.com/api/brand/logo/sa/sa2?v=1"],
  ["the same id under the other scope", "https://crm.example.com/api/brand/logo/agency/sa1?v=1"],
  ["the prefix in a query", "https://cdn.example.com/x.png?r=/api/brand/logo/"],
  ["our path behind a query on another page", "https://crm.example.com/l/x?r=/api/brand/logo/sa/sa1"],
  ["our path on another host", "https://evil.example/api/brand/logo/sa/sa1?v=1"],
  ["our path on another port", "https://crm.example.com:8443/api/brand/logo/sa/sa1?v=1"],
  ["a longer path", "https://crm.example.com/api/brand/logo/sa/sa1/x"],
  ["an id with our id as a prefix", "https://crm.example.com/api/brand/logo/sa/sa10?v=1"],
  ["not a URL", "/api/brand/logo/sa/sa1"],
  ["empty", ""],
])("refuses %s", (_label, url) => {
  expect(isUploadedLogoUrl(url, "sa", "sa1")).toBe(false);
});

it("is false when the app URL is unset", () => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
  expect(isUploadedLogoUrl("https://crm.example.com/api/brand/logo/sa/sa1?v=1", "sa", "sa1")).toBe(false);
});

describe("pointsAtUploadedLogo (Remove's server-side match)", () => {
  it("matches this tenant's path on any origin", () => {
    expect(pointsAtUploadedLogo("https://old-host.example.org/api/brand/logo/sa/sa1?v=1", "sa", "sa1")).toBe(true);
    expect(pointsAtUploadedLogo("https://crm.example.com/api/brand/logo/sa/sa1", "sa", "sa1")).toBe(true);
  });

  it.each([
    ["another tenant's path", "https://crm.example.com/api/brand/logo/sa/sa2?v=1"],
    ["the other scope", "https://crm.example.com/api/brand/logo/agency/sa1?v=1"],
    ["the prefix in a query", "https://cdn.example.com/x.png?r=/api/brand/logo/sa/sa1"],
    ["a longer path", "https://crm.example.com/api/brand/logo/sa/sa1/x"],
    ["not absolute", "/api/brand/logo/sa/sa1"],
    ["empty", ""],
  ])("refuses %s", (_label, url) => {
    expect(pointsAtUploadedLogo(url, "sa", "sa1")).toBe(false);
  });
});
