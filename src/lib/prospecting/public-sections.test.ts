import { describe, expect, it } from "vitest";
import type { ProspectSectionResult } from "@/types";
import { MEMBER_RAW_KEYS, publicSection } from "./public-sections";
import { BUSINESS, FULL_DETAILS, RICH_HOMEPAGE } from "./sections/sections.fixture";
import * as ads from "./sections/ads";
import * as businessDetails from "./sections/business-details";
import * as leadCapture from "./sections/lead-capture";
import * as reputation from "./sections/reputation";
import * as techStack from "./sections/tech-stack";
import type { SectionInput } from "./sections/types";
import { apexgeoFromScan } from "./apexgeo-sections";
import { completedScan } from "./apexgeo.fixture";

/**
 * The public whitelist, run over the raw shapes the real sections produce.
 * Pins the exact detail keys per section, and that nothing identifying
 * (CRM phone/address, URLs of directory pages, provider ids)
 * leaks through — only what `public-sections.ts` names.
 */

const input: SectionInput = {
  business: BUSINESS,
  homepage: { html: RICH_HOMEPAGE, url: "https://www.fixture-plumbing.example.com/" },
  signal: new AbortController().signal,
  count: () => undefined,
};

const gbpResult: ProspectSectionResult = {
  key: "gbp",
  status: "ok",
  score: 100,
  findings: [],
  raw: { details: FULL_DETAILS, description: "notMeasured", claimed: "notMeasured" },
};

const listingsResult: ProspectSectionResult = {
  key: "listings",
  status: "ok",
  score: 50,
  findings: [],
  raw: {
    checks: [
      { directory: "Facebook", url: "https://www.facebook.com/FixturePlumbing/", status: "found" },
      { directory: "Bing", url: "https://www.bing.com/search?q=x", status: "not_found" },
      { directory: "Brabys", url: "https://www.brabys.com/search?q=x", status: "unknown" },
      { directory: "Evil <script>", url: null, status: "found" },
      { directory: "Cylex", url: null, status: "<b>bad</b>" },
    ],
  },
};

describe("publicSection whitelist", () => {
  it("emits exactly the named keys per section", async () => {
    const results = [
      await businessDetails.run(input),
      gbpResult,
      await reputation.run(input),
      listingsResult,
      await techStack.run(input),
      await ads.run(input),
      await leadCapture.run(input),
    ];
    const keys = Object.fromEntries(
      results.map((r) => [r.key, Object.keys(publicSection(r, { showName: true }).details).sort()]),
    );
    expect(keys).toEqual({
      business_details: ["category", "https", "name", "website"],
      gbp: ["description", "hoursListed", "phoneListed", "photoCount"],
      reputation: ["ownerReplyRate", "rating", "reviewsCount", "velocity90d"],
      listings: ["Bing", "Brabys", "Facebook"],
      tech_stack: ["technologies"],
      ads: ["googleAdsTransparencyUrl", "metaAdLibraryUrl"],
      lead_capture: ["booking", "chatWidget", "contactForm", "phoneLink", "whatsapp"],
    });
  });

  it("never shows lead capture's formUrl, publicly or to members (the mystery shop reads it server-side)", async () => {
    const lead = await leadCapture.run(input);
    expect(lead.raw).toMatchObject({ formUrl: expect.stringMatching(/^https:/) });
    expect(publicSection(lead, { showName: true }).details).not.toHaveProperty("formUrl");
    expect(publicSection(lead, { showName: true, keys: MEMBER_RAW_KEYS }).details).not.toHaveProperty("formUrl");
  });

  it("carries the values, flattened to scalars", async () => {
    expect(publicSection(gbpResult, { showName: true }).details).toEqual({
      description: "notMeasured",
      hoursListed: true,
      photoCount: 1,
      phoneListed: true,
    });
    expect(publicSection(listingsResult, { showName: true }).details).toEqual({
      Facebook: "found",
      Bing: "not_found",
      Brabys: "unknown",
    });
    const tech = publicSection(await techStack.run(input), { showName: true }).details.technologies;
    expect(tech).toContain("WordPress");
    expect(publicSection(await businessDetails.run(input), { showName: true }).details).toEqual({
      name: BUSINESS.name,
      website: BUSINESS.website,
      category: "Plumber",
      https: true,
    });
  });

  it("leaks nothing identifying", async () => {
    const all = JSON.stringify(
      [await businessDetails.run(input), gbpResult, listingsResult].map((r) => publicSection(r, { showName: true })),
    );
    for (const secret of [
      BUSINESS.phone!,
      BUSINESS.address!,
      FULL_DETAILS.nationalPhoneNumber,
      FULL_DETAILS.id,
      "bing.com",
      "Monday",
    ]) {
      expect(all).not.toContain(secret);
    }
  });

  it("drops non-scalar values under a whitelisted key", () => {
    const r = publicSection({
      key: "reputation",
      status: "ok",
      score: 50,
      findings: [],
      raw: { rating: { html: "<p>x</p>" }, reviewsCount: 12 },
    }, { showName: true });
    expect(r.details).toEqual({ reviewsCount: 12 });
  });
});

describe("publicSection — ApexGEO sections 5/7/8", () => {
  const scan = completedScan();
  scan.ai_visibility.prompts[0].engines[0].cited_url = "https://cited.example/x";
  const results = apexgeoFromScan(scan as never).map((r) => ({
    ...r,
    // A raw key a future scorer might add must still not pass.
    raw: { ...r.raw, answers: "ANSWER-SENTINEL", error: "ERR-SENTINEL", issues: "ISSUE-SENTINEL" },
  }));

  it("emits exactly the named keys", () => {
    expect(Object.fromEntries(results.map((r) => [r.key, Object.keys(publicSection(r, { showName: true }).details).sort()]))).toEqual({
      website_performance: ["cls", "fcpSeconds", "lcpSeconds", "mobileViewport", "speedIndexSeconds", "tbtMs"],
      ai_readiness: ["ClaudeBot", "GPTBot", "Google-Extended", "PerplexityBot", "localBusinessSchema", "robotsTxt"],
      ai_presence: ["answersMeasured", "mentionedIn", "question1", "question2", "question3", "topCompetitors"],
    });
  });

  it("the questions asked are public; the models asked are members-only (C4, C7)", () => {
    const presence = results.find((r) => r.key === "ai_presence")!;
    expect(publicSection(presence, { showName: true }).details).toMatchObject({
      question1: "best plumber in Exampletown",
      question3: "recommended plumber Exampletown reviews",
    });
    expect(publicSection(presence, { showName: true }).details).not.toHaveProperty("models");
    expect(publicSection(presence, { showName: true, keys: MEMBER_RAW_KEYS }).details.models).toBe(
      "gemini-2.5-flash, gpt-4o-mini",
    );
  });

  it("no answer text, cited URL, provider error or unnamed raw key leaks", () => {
    const all = JSON.stringify(results.map((r) => publicSection(r, { showName: true })));
    // Per-question competitor lists stay in raw: only the question text is derived.
    for (const leak of ["SENTINEL", "cited.example", "Delta Plumbquick", "insufficient_quota", "No FAQ Schema"]) {
      expect(all).not.toContain(leak);
    }
  });

  it("carries a known reasonCode and drops an unknown one", () => {
    const base = { key: "ai_presence" as const, status: "unavailable" as const, score: null, findings: [], raw: {} };
    expect(publicSection({ ...base, reasonCode: "pending" }, { showName: true }).reasonCode).toBe("pending");
    expect(publicSection({ ...base, reasonCode: "<b>x</b>" as never }, { showName: true }).reasonCode).toBeNull();
    expect(publicSection(base, { showName: true }).reasonCode).toBeNull();
  });
});
