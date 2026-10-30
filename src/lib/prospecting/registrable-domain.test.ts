import { describe, expect, it } from "vitest";
import { registrableDomain, sameSite } from "./registrable-domain";

describe("registrableDomain (Public Suffix List, private suffixes included)", () => {
  it.each([
    ["www.acme.co.za", "acme.co.za"], ["shop.acme.com", "acme.com"], ["acme.org.za", "acme.org.za"],
    ["WWW.Acme.CO.ZA.", "acme.co.za"], ["a.wixsite.com", "a.wixsite.com"], ["x.github.io", "x.github.io"],
    ["b.blogspot.com", "b.blogspot.com"], ["app.vercel.app", "app.vercel.app"], ["site.netlify.app", "site.netlify.app"],
  ])("%s → %s", (host, domain) => {
    expect(registrableDomain(host)).toBe(domain);
  });

  it.each(["127.0.0.1", "[::1]", "co.za", "localhost", "github.io"])("%s has none", (host) => {
    expect(registrableDomain(host)).toBeNull();
  });
});

describe("sameSite", () => {
  it("the same business under www, a subdomain or the bare domain", () => {
    expect(sameSite("www.acme.co.za", "shop.acme.co.za")).toBe(true);
    expect(sameSite("acme.co.za", "www.acme.co.za")).toBe(true);
  });

  it("never another tenant of a hosting platform, or another name under a public suffix", () => {
    expect(sameSite("a.wixsite.com", "b.wixsite.com")).toBe(false);
    expect(sameSite("x.github.io", "y.github.io")).toBe(false);
    expect(sameSite("a.blogspot.com", "b.blogspot.com")).toBe(false);
    expect(sameSite("acme.org.za", "evil.org.za")).toBe(false);
    expect(sameSite("acme.co.za", "acme.co.za.evil.com")).toBe(false);
  });

  it("a host with no registrable domain matches only itself", () => {
    expect(sameSite("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(sameSite("127.0.0.1", "127.0.0.2")).toBe(false);
    expect(sameSite("localhost", "127.0.0.1")).toBe(false);
    expect(sameSite("github.io", "x.github.io")).toBe(false);
  });
});
