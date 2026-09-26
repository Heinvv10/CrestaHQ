import { describe, expect, it } from "vitest";
import { run, score } from "./tech-stack";
import { detectTech, TECH_RULES } from "./tech-rules";
import { BARE_HOMEPAGE, BUSINESS, RICH_HOMEPAGE } from "./sections.fixture";

const input = (html: string | null, website = BUSINESS.website) => ({
  business: { ...BUSINESS, website },
  homepage: html === null ? null : { html, url: "https://fixture.example.com/" },
  signal: new AbortController().signal,
  count: () => undefined,
});

describe("tech rules", () => {
  it("detects CMS, analytics, pixel, chat and booking on the rich fixture", () => {
    expect(detectTech(RICH_HOMEPAGE).map((t) => t.name)).toEqual([
      "WordPress",
      "Google Analytics",
      "Meta Pixel",
      "Tawk.to",
      "Calendly",
    ]);
  });

  it("matches case-insensitively", () => {
    expect(detectTech(`<SCRIPT SRC="HTTPS://EMBED.TAWK.TO/X"></SCRIPT>`).map((t) => t.name)).toEqual(["Tawk.to"]);
  });

  it("detects nothing on a bare page", () => {
    expect(detectTech(BARE_HOMEPAGE)).toEqual([]);
  });

  it("has ~40+ rules, all lower-case patterns (matching lower-cases the page)", () => {
    expect(TECH_RULES.length).toBeGreaterThanOrEqual(40);
    for (const rule of TECH_RULES) for (const p of rule.patterns) expect(p).toBe(p.toLowerCase());
  });

  it("stays linear on a hostile page", () => {
    const hostile = "<".repeat(200_000) + "wp-content".repeat(20_000);
    const t0 = performance.now();
    detectTech(hostile);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("tech_stack score", () => {
  it("analytics + pixel scores 100", () => {
    expect(score({ detected: [{ name: "GA", category: "analytics" }, { name: "Pixel", category: "ads_pixel" }] })).toEqual({
      score: 100,
      findings: [],
    });
  });

  it("analytics alone scores 60", () => {
    expect(score({ detected: [{ name: "GA", category: "analytics" }] })).toEqual({ score: 60, findings: [] });
  });

  it("no analytics is no_analytics; a pixel alone scores 40", () => {
    const out = score({ detected: [{ name: "Pixel", category: "ads_pixel" }] });
    expect(out.score).toBe(40);
    expect(out.findings.map((f) => f.code)).toEqual(["no_analytics"]);
  });

  it("never emits no_chat_widget (that is lead_capture's)", () => {
    expect(score({ detected: [] }).findings.map((f) => f.code)).toEqual(["no_analytics"]);
  });
});

describe("tech_stack run", () => {
  it("is unavailable without a website", async () => {
    expect(await run(input(null, null))).toMatchObject({ status: "unavailable", reason: "No website to inspect." });
  });

  it("is unavailable when the homepage could not be fetched", async () => {
    expect(await run(input(null))).toMatchObject({ status: "unavailable", reason: "The website could not be fetched." });
  });

  it("reports what it detected", async () => {
    const out = await run(input(RICH_HOMEPAGE));
    expect(out.status).toBe("ok");
    expect(out.score).toBe(100);
    expect((out.raw.detected as { name: string }[]).map((t) => t.name)).toContain("WordPress");
  });
});
