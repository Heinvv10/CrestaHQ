import { describe, expect, it } from "vitest";
import type { ProspectFindingCode, ProspectSectionResult } from "@/types";
import { headline, SEVERITY_ORDER } from "./severity";

function section(
  key: ProspectSectionResult["key"],
  codes: ProspectFindingCode[],
  status: ProspectSectionResult["status"] = "ok",
): ProspectSectionResult {
  return {
    key,
    status,
    score: status === "ok" ? 50 : null,
    findings: codes.map((code, i) => ({ code, text: `${key}:${code}:${i}` })),
    raw: {},
  };
}

// Every code in the union, listed independently of severity.ts.
const ALL_CODES: Record<ProspectFindingCode, true> = {
  no_website: true, no_https: true, not_in_ai_answers: true, gbp_unclaimed: true, slow_mobile: true,
  no_whatsapp_cta: true, no_reviews: true, low_rating: true, few_reviews: true, no_booking: true,
  no_contact_form: true, no_phone_link: true, gbp_no_hours: true, gbp_no_photos: true,
  gbp_no_description: true, gbp_no_phone: true, listing_missing: true, no_analytics: true,
  no_chat_widget: true, no_ads_running: true, ai_crawlers_blocked: true, no_local_business_schema: true,
};

describe("SEVERITY_ORDER", () => {
  it("ranks every finding code exactly once", () => {
    expect([...SEVERITY_ORDER].sort()).toEqual(Object.keys(ALL_CODES).sort());
  });

  it("starts with the plan's fixed order (PR 3's ai_crawlers_blocked sits inside it, above no_whatsapp_cta)", () => {
    expect(SEVERITY_ORDER.slice(0, 7)).toEqual([
      "no_website", "no_https", "not_in_ai_answers", "gbp_unclaimed", "slow_mobile", "ai_crawlers_blocked",
      "no_whatsapp_cta",
    ]);
  });

  it("no_local_business_schema ranks below listing_missing's neighbours, above chat and analytics", () => {
    const at = (c: string) => SEVERITY_ORDER.indexOf(c as never);
    expect(at("no_local_business_schema")).toBeGreaterThan(at("listing_missing"));
    expect(at("no_local_business_schema")).toBeLessThan(at("no_chat_widget"));
  });
});

describe("headline", () => {
  it("picks the worst finding across sections, regardless of position", () => {
    const out = headline([
      section("lead_capture", ["no_chat_widget", "no_whatsapp_cta"]),
      section("business_details", ["no_https"]),
      section("reputation", ["few_reviews"]),
    ]);
    expect(out).toBe("business_details:no_https:0");
  });

  it("ignores findings on sections that are not ok", () => {
    const out = headline([
      section("business_details", ["no_website"], "failed"),
      section("tech_stack", ["no_analytics"]),
    ]);
    expect(out).toBe("tech_stack:no_analytics:0");
  });

  it("breaks ties by section order, then finding order", () => {
    expect(headline([section("listings", ["listing_missing"]), section("gbp", ["listing_missing"])])).toBe(
      "listings:listing_missing:0",
    );
    expect(headline([section("listings", ["listing_missing", "listing_missing"])])).toBe("listings:listing_missing:0");
  });

  it("is null when there are no findings", () => {
    expect(headline([section("gbp", [])])).toBeNull();
    expect(headline([])).toBeNull();
  });
});
