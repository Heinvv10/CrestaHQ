import { describe, expect, it } from "vitest";
import type { ProspectFinding, ProspectFindingCode } from "@/types";
import { completedScan } from "../apexgeo.fixture";
import type { ApexgeoScan } from "../apexgeo-client";
import { SEVERITY_ORDER } from "../severity";
import * as aiPresence from "./ai-presence";
import * as aiReadiness from "./ai-readiness";
import * as businessDetails from "./business-details";
import { DEDUCTIONS, FINDING_COPY } from "./findings";
import * as gbp from "./gbp";
import * as leadCapture from "./lead-capture";
import * as reputation from "./reputation";
import { BARE_DETAILS, FULL_DETAILS } from "./sections.fixture";
import * as techStack from "./tech-stack";
import * as websitePerformance from "./website-performance";
import type { Scored } from "./types";

/**
 * "A score comes only from findings" (R0b, C3), over every scored section and
 * a spread of inputs: a score below 100 always has a finding, and the score is
 * exactly 100 minus the deduction table's values for those findings.
 */

type Case = [label: string, scored: Scored | null];

const scan = (mutate: (s: ReturnType<typeof completedScan>) => void = () => {}): ApexgeoScan => {
  const s = completedScan();
  mutate(s);
  return s as unknown as ApexgeoScan;
};

const bool = [true, false];
const bd = { name: "N", phone: null, address: null, website: "https://x.test", category: null, https: true };

const cases: Case[] = [
  ...[null, "https://x.test"].flatMap((website) =>
    [true, false, null].map((https): Case => [`business_details ${website} ${https}`, businessDetails.score({ ...bd, website, https })]),
  ),
  ["gbp full", gbp.score(FULL_DETAILS)],
  ["gbp bare", gbp.score(BARE_DETAILS)],
  ["gbp no photos", gbp.score({ ...FULL_DETAILS, photos: [] })],
  ...[null, 1, 3.9, 4.0, 4.7, 4.8, 5].flatMap((rating) =>
    [null, 0, 1, 9, 10, 49, 50, 500].map((reviewsCount): Case => [
      `reputation ${rating}/${reviewsCount}`,
      reputation.score({ rating, reviewsCount }),
    ]),
  ),
  ...bool.flatMap((whatsapp) =>
    bool.flatMap((booking) =>
      bool.map((contactForm): Case => [
        `lead_capture ${whatsapp}/${booking}/${contactForm}`,
        leadCapture.score({ whatsapp, booking, contactForm, phoneLink: !booking, chatWidget: whatsapp }),
      ]),
    ),
  ),
  ["tech_stack none", techStack.score({ detected: [] })],
  ["tech_stack pixel only", techStack.score({ detected: [{ name: "P", category: "ads_pixel" }] })],
  ["tech_stack analytics", techStack.score({ detected: [{ name: "GA", category: "analytics" }] })],
  ...[1000, 2500, 2501, 4000, 4001, 14000].flatMap((lcp) =>
    [true, false, null].map((viewport): Case => [
      `website_performance ${lcp}/${viewport}`,
      websitePerformance.score(
        scan((s) => {
          s.technical.core_web_vitals.lcp_ms = lcp;
          (s.technical as { mobile_viewport: boolean | null }).mobile_viewport = viewport;
        }).technical,
      ),
    ]),
  ),
  ...bool.flatMap((schema) =>
    (["allowed", "blocked", null] as const).map((gpt): Case => [
      `ai_readiness ${schema}/${gpt}`,
      aiReadiness.score(
        scan((s) => {
          s.ai_readiness.local_business_schema = schema;
          (s.ai_readiness.robots as Record<string, string | null>).GPTBot = gpt;
        }).ai_readiness,
      ),
    ]),
  ),
  ...[0, 1, 3, 6].map((named): Case => [
    `ai_presence named in ${named}`,
    aiPresence.score(
      scan((s) =>
        s.ai_visibility.prompts
          .flatMap((p) => p.engines.filter((e) => e.error === null))
          .forEach((e, i) => (e.mentioned = i < named)),
      ).ai_visibility,
    ),
  ]),
  [
    "ai_presence incomplete",
    aiPresence.score(scan((s) => void (s.ai_visibility.prompts[2].engines[2].error = "x")).ai_visibility),
  ],
];

const deducted = (findings: ProspectFinding[]) => Math.max(0, 100 - findings.reduce((n, f) => n + DEDUCTIONS[f.code], 0));

describe("every scored section", () => {
  it.each(cases)("%s: a score below 100 has a finding, and equals 100 minus its deductions", (_label, scored) => {
    if (!scored || scored.score === null) {
      expect(scored?.findings ?? []).toEqual([]);
      return;
    }
    if (scored.score < 100) expect(scored.findings.length).toBeGreaterThan(0);
    expect(scored.score).toBe(deducted(scored.findings));
  });

  it("exercises a deduction for every code a scorer can emit today", () => {
    const seen = new Set(cases.flatMap(([, s]) => s?.findings.map((f) => f.code) ?? []));
    const neverEmitted: ProspectFindingCode[] = ["gbp_unclaimed", "gbp_no_description", "listing_missing", "no_ads_running"];
    expect([...seen].sort()).toEqual(SEVERITY_ORDER.filter((c) => !neverEmitted.includes(c)).sort());
  });

  it("every finding carries its stored impact and CTA", () => {
    for (const [, s] of cases) {
      for (const f of s?.findings ?? []) expect(f).toEqual({ code: f.code, text: f.text, ...FINDING_COPY[f.code] });
    }
  });
});

describe("the deduction table", () => {
  it("every scored code deducts something; unscored sections' codes deduct nothing", () => {
    for (const code of SEVERITY_ORDER) {
      if (code === "listing_missing" || code === "no_ads_running") expect(DEDUCTIONS[code]).toBe(0);
      else expect(DEDUCTIONS[code]).toBeGreaterThan(0);
    }
  });

  it("a stricter code deducts more than the milder one it replaces", () => {
    expect(DEDUCTIONS.low_rating).toBeGreaterThan(DEDUCTIONS.rating_under_4_8);
    expect(DEDUCTIONS.few_reviews).toBeGreaterThan(DEDUCTIONS.reviews_under_50);
    expect(DEDUCTIONS.slow_mobile).toBeGreaterThan(DEDUCTIONS.lcp_needs_improvement);
    expect(DEDUCTIONS.not_in_ai_answers).toBeGreaterThan(DEDUCTIONS.ai_mentions_partial);
  });
});
