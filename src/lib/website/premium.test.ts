import { describe, expect, it } from "vitest";
import { blankPremiumDetails, type WebsitePremiumDetails } from "@/types/website";
import {
  PREMIUM_LIMITS,
  parseBrandVoice,
  parseCaseStudies,
  parseMetrics,
  parseSocialLinks,
  parseTeam,
  parseTestimonials,
  parseTools,
  premiumDetailsPayload,
  premiumModeFor,
  validatePremiumDetails,
} from "./premium";

const details = (over: Partial<WebsitePremiumDetails> = {}): WebsitePremiumDetails => ({
  ...blankPremiumDetails(),
  ...over,
});

describe("parsers", () => {
  it("parseMetrics splits on the last colon and keeps unparseable lines label-only", () => {
    expect(parseMetrics("Members: 1,200\nOpen: 24:7\nnocolon")).toEqual([
      { label: "Members", value: "1,200" },
      { label: "Open: 24", value: "7" },
      { label: "nocolon", value: "" },
    ]);
  });

  it("parseTeam and parseTestimonials drop empty optional columns", () => {
    expect(parseTeam("Sam | Owner")).toEqual([{ name: "Sam", role: "Owner" }]);
    expect(parseTestimonials("Great | Ann")).toEqual([{ quote: "Great", name: "Ann" }]);
    expect(parseTestimonials("Great | Ann | Client")).toEqual([
      { quote: "Great", name: "Ann", role: "Client" },
    ]);
  });

  it("parseSocialLinks, parseBrandVoice, parseTools trim and skip blanks", () => {
    expect(parseSocialLinks("IG | https://instagram.com/x\n\n")).toEqual([
      { label: "IG", url: "https://instagram.com/x" },
    ]);
    expect(parseBrandVoice(" direct, , warm ")).toEqual(["direct", "warm"]);
    expect(parseTools("n8n, Make , ")).toEqual(["n8n", "Make"]);
    expect(parseTools(undefined)).toEqual([]);
    expect(parseCaseStudies("Acme | 2x faster | Built a bot")).toEqual([
      { client: "Acme", result: "2x faster", detail: "Built a bot" },
    ]);
  });
});

describe("validatePremiumDetails", () => {
  it("accepts blank details", () => {
    expect(validatePremiumDetails(details())).toEqual({});
  });

  it("flags over-length tagline and bad founded year", () => {
    const e = validatePremiumDetails(
      details({ tagline: "x".repeat(PREMIUM_LIMITS.tagline + 1), founded_year: "1799" }),
    );
    expect(e.tagline).toBeDefined();
    expect(e.founded_year).toBeDefined();
    expect(validatePremiumDetails(details({ founded_year: "2010" }))).toEqual({});
    expect(validatePremiumDetails(details({ founded_year: "20.5" })).founded_year).toBeDefined();
  });

  it("limits brand voice to 5 words", () => {
    expect(validatePremiumDetails(details({ brand_voice: "a,b,c,d,e" }))).toEqual({});
    expect(validatePremiumDetails(details({ brand_voice: "a,b,c,d,e,f" })).brand_voice).toBeDefined();
  });

  it("requires label and value on metrics, and caps the count", () => {
    expect(validatePremiumDetails(details({ metrics: "Members" })).metrics).toBeDefined();
    const five = Array.from({ length: PREMIUM_LIMITS.metrics + 1 }, (_, i) => `L${i}: ${i}`).join("\n");
    expect(validatePremiumDetails(details({ metrics: five })).metrics).toBeDefined();
    expect(validatePremiumDetails(details({ metrics: "Members: 10" }))).toEqual({});
  });

  it("requires quote and name on testimonials", () => {
    expect(validatePremiumDetails(details({ testimonials: "Great" })).testimonials).toBeDefined();
    expect(validatePremiumDetails(details({ testimonials: "Great | Ann" }))).toEqual({});
  });

  it("requires https on social links", () => {
    expect(validatePremiumDetails(details({ social_links: "IG | http://x.com" })).social_links).toBeDefined();
    expect(validatePremiumDetails(details({ social_links: "IG | https://x.com" }))).toEqual({});
  });

  it("validates the AI-niche tools and case studies", () => {
    const tooMany = Array.from({ length: PREMIUM_LIMITS.tools + 1 }, (_, i) => `t${i}`).join(",");
    expect(validatePremiumDetails(details({ tools: tooMany }), "ai_automation").tools).toBeDefined();
    expect(validatePremiumDetails(details({ case_studies: "Acme" }), "ai_consulting").case_studies).toBeDefined();
    expect(validatePremiumDetails(details({ case_studies: "Acme | Won" }), "ai_consulting")).toEqual({});
  });

  it("ignores niche-only fields off-niche, so a hidden field cannot fail validation", () => {
    const tooMany = Array.from({ length: PREMIUM_LIMITS.tools + 1 }, (_, i) => `t${i}`).join(",");
    const bad = details({ tools: tooMany, case_studies: "Acme" });
    for (const niche of [null, "gym_fitness", "home_services"]) {
      expect(validatePremiumDetails(bad, niche)).toEqual({});
    }
    expect(validatePremiumDetails(bad)).toEqual({});
    // case studies also apply to agency_consulting; tools do not.
    const agency = validatePremiumDetails(bad, "agency_consulting");
    expect(agency.case_studies).toBeDefined();
    expect(agency.tools).toBeUndefined();
    // General fields still validate off-niche.
    expect(validatePremiumDetails(details({ founded_year: "1500" }), "gym_fitness").founded_year).toBeDefined();
  });
});

describe("premiumDetailsPayload", () => {
  it("returns {} for null and omits blank fields", () => {
    expect(premiumDetailsPayload(null)).toEqual({});
    expect(premiumDetailsPayload(details())).toEqual({});
  });

  it("builds the typed block, dropping incomplete rows", () => {
    const p = premiumDetailsPayload(
      details({
        tagline: " Stronger ",
        founded_year: "2015",
        brand_voice: "direct, warm",
        metrics: "Members: 10\nbroken",
        team: "Sam | Coach",
        testimonials: "Nice | Ann\nnoname",
        offer_headline: "Free week",
        offer_bullets: "One\nTwo",
        social_links: "IG | https://x.com",
        tools: "n8n",
        case_studies: "Acme | Won",
      }),
      "ai_automation",
    );
    expect(p).toEqual({
      tagline: "Stronger",
      foundedYear: 2015,
      brandVoice: ["direct", "warm"],
      metrics: [{ label: "Members", value: "10" }],
      team: [{ name: "Sam", role: "Coach" }],
      testimonials: [{ quote: "Nice", name: "Ann" }],
      offer: { headline: "Free week", bullets: ["One", "Two"] },
      socialLinks: [{ label: "IG", url: "https://x.com" }],
      tools: ["n8n"],
      caseStudies: [{ client: "Acme", result: "Won" }],
    });
  });

  it("omits niche-only fields off-niche and keeps case studies for agency_consulting", () => {
    const d = details({ tagline: "T", tools: "n8n", case_studies: "Acme | Won" });
    for (const niche of [null, "gym_fitness"]) {
      expect(premiumDetailsPayload(d, niche)).toEqual({ tagline: "T" });
    }
    expect(premiumDetailsPayload(d)).toEqual({ tagline: "T" });
    expect(premiumDetailsPayload(d, "agency_consulting")).toEqual({
      tagline: "T",
      caseStudies: [{ client: "Acme", result: "Won" }],
    });
  });

  it("premiumModeFor maps the colour scheme", () => {
    expect(premiumModeFor({ color_scheme: "Dark Mode" })).toBe("dark");
    expect(premiumModeFor({ color_scheme: "Standard" })).toBe("light");
  });
});
