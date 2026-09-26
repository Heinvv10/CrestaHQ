import { describe, expect, it } from "vitest";
import type { ProspectSectionResult } from "@/types";
import { publicSection } from "./public-sections";
import { BUSINESS, FULL_DETAILS, RICH_HOMEPAGE } from "./sections/sections.fixture";
import * as ads from "./sections/ads";
import * as businessDetails from "./sections/business-details";
import * as leadCapture from "./sections/lead-capture";
import * as reputation from "./sections/reputation";
import * as techStack from "./sections/tech-stack";
import type { SectionInput } from "./sections/types";

/**
 * The public whitelist, run over the raw shapes the real sections produce.
 * Pins the exact detail keys per section, and that nothing identifying
 * (listing phone/address/website, URLs of directory pages, provider ids)
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
      results.map((r) => [r.key, Object.keys(publicSection(r).details).sort()]),
    );
    expect(keys).toEqual({
      business_details: ["category", "https"],
      gbp: ["description", "hoursListed", "phoneListed", "photoCount"],
      reputation: ["ownerReplyRate", "rating", "reviewsCount", "velocity90d"],
      listings: ["Bing", "Brabys", "Facebook"],
      tech_stack: ["technologies"],
      ads: ["googleAdsTransparencyUrl", "metaAdLibraryUrl"],
      lead_capture: ["booking", "chatWidget", "contactForm", "phoneLink", "whatsapp"],
    });
  });

  it("carries the values, flattened to scalars", async () => {
    expect(publicSection(gbpResult).details).toEqual({
      description: "notMeasured",
      hoursListed: true,
      photoCount: 1,
      phoneListed: true,
    });
    expect(publicSection(listingsResult).details).toEqual({
      Facebook: "found",
      Bing: "not_found",
      Brabys: "unknown",
    });
    const tech = publicSection(await techStack.run(input)).details.technologies;
    expect(tech).toContain("WordPress");
    expect(publicSection(await businessDetails.run(input)).details).toEqual({
      category: "Plumber",
      https: true,
    });
  });

  it("leaks nothing identifying", async () => {
    const all = JSON.stringify(
      [await businessDetails.run(input), gbpResult, listingsResult].map(publicSection),
    );
    for (const secret of [
      BUSINESS.phone!,
      BUSINESS.address!,
      "fixture-plumbing.example.com",
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
    });
    expect(r.details).toEqual({ reviewsCount: 12 });
  });
});
