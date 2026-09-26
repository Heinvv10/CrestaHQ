import { describe, expect, it } from "vitest";
import { landingDefersToPrimaryDomain } from "./marketing-host";

describe("landingDefersToPrimaryDomain", () => {
  it("defers when the app runs on a subdomain of the marketing domain", () => {
    expect(landingDefersToPrimaryDomain("https://crm.crestahq.com", "crestahq.com")).toBe(true);
  });
  it("does not defer when the app is the primary domain, with or without www", () => {
    expect(landingDefersToPrimaryDomain("https://crestahq.com/", "crestahq.com")).toBe(false);
    expect(landingDefersToPrimaryDomain("https://www.crestahq.com", "crestahq.com")).toBe(false);
    expect(landingDefersToPrimaryDomain("https://crestahq.com", "www.crestahq.com")).toBe(false);
  });
  it("does not defer when the app is on an unrelated domain (placeholder primaryDomain left unedited)", () => {
    expect(landingDefersToPrimaryDomain("https://buyer-agency.co.za", "crestahq.com")).toBe(false);
    expect(landingDefersToPrimaryDomain("https://app.buyer-agency.co.za", "crestahq.com")).toBe(false);
    expect(landingDefersToPrimaryDomain("https://notcrestahq.com", "crestahq.com")).toBe(false);
  });
  it("does not defer when either side is unknown", () => {
    expect(landingDefersToPrimaryDomain(undefined, "crestahq.com")).toBe(false);
    expect(landingDefersToPrimaryDomain("not a url", "crestahq.com")).toBe(false);
    expect(landingDefersToPrimaryDomain("https://crm.crestahq.com", "")).toBe(false);
  });
});
