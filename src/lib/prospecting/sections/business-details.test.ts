import { describe, expect, it } from "vitest";
import { run, score, type BusinessDetailsRaw } from "./business-details";
import { BUSINESS } from "./sections.fixture";

const complete: BusinessDetailsRaw = {
  name: "Fixture Plumbing",
  phone: "041 555 0100",
  address: "1 Test Street",
  website: "https://fixture.example.com/",
  category: "Plumber",
  https: true,
};

const input = (homepageUrl: string | null, website = BUSINESS.website) => ({
  business: { ...BUSINESS, website },
  homepage: homepageUrl ? { html: "<html></html>", url: homepageUrl } : null,
  signal: new AbortController().signal,
  count: () => undefined,
});

describe("business_details score", () => {
  it("scores a complete HTTPS business 100 with no findings", () => {
    expect(score(complete)).toEqual({ score: 100, findings: [] });
  });

  it("scores by completeness: two of five fields missing is 60", () => {
    expect(score({ ...complete, phone: null, category: null }).score).toBe(60);
  });

  it("flags no_website and loses the website's share", () => {
    const out = score({ ...complete, website: null, https: null });
    expect(out.score).toBe(80);
    expect(out.findings.map((f) => f.code)).toEqual(["no_website"]);
  });

  it("flags no_https and takes the HTTPS penalty", () => {
    const out = score({ ...complete, https: false });
    expect(out.score).toBe(80);
    expect(out.findings.map((f) => f.code)).toEqual(["no_https"]);
  });

  it("does not flag no_https when the homepage could not be fetched", () => {
    expect(score({ ...complete, https: null })).toEqual({ score: 100, findings: [] });
  });
});

describe("business_details run", () => {
  it("counts a site that redirected http → https as HTTPS", async () => {
    const out = await run(input("https://www.fixture-plumbing.example.com/"));
    expect(out.status).toBe("ok");
    expect(out.raw.https).toBe(true);
    expect(out.findings).toEqual([]);
  });

  it("flags a site whose final URL is http", async () => {
    const out = await run(input("http://www.fixture-plumbing.example.com/"));
    expect(out.findings.map((f) => f.code)).toEqual(["no_https"]);
  });

  it("flags no_website when the business has none", async () => {
    const out = await run(input(null, null));
    expect(out.findings.map((f) => f.code)).toEqual(["no_website"]);
  });
});
