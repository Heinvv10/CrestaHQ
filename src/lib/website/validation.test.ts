import { describe, expect, it } from "vitest";
import {
  blankBusinessDetails,
  blankPremiumDetails,
  effectiveQuality,
  sampleAgencyConsultingLocalConfig,
  sampleAgencyConsultingVslConfig,
  sampleAiAutomationLocalConfig,
  sampleAiAutomationVslConfig,
  sampleAiConsultingLocalConfig,
  sampleAiConsultingVslConfig,
  sampleGymFitnessLocalConfig,
  sampleHomeServicesLocalConfig,
  wantsChatWidget,
  wantsLeadForm,
  wantsWebVoice,
  type WebsiteConfig,
} from "@/types/website";
import { NICHE_KEYS, NICHE_META, isNicheKey } from "./niches";
import { validateWebsiteConfig } from "./validation";

const aiLocal = (): WebsiteConfig => {
  const c = sampleAiConsultingLocalConfig();
  c.business_details = { ...blankBusinessDetails(), business_name: "Remote Co" };
  return c;
};

// home_services and real_estate samples predate this unit and already exceed
// the 60/80-char limits (unchanged upstream), so they are not asserted here.
describe("niche samples", () => {
  it.each([
    ["gym_fitness", sampleGymFitnessLocalConfig],
    ["agency local", sampleAgencyConsultingLocalConfig],
    ["agency vsl", sampleAgencyConsultingVslConfig],
    ["ai_consulting local", sampleAiConsultingLocalConfig],
    ["ai_consulting vsl", sampleAiConsultingVslConfig],
    ["ai_automation local", sampleAiAutomationLocalConfig],
    ["ai_automation vsl", sampleAiAutomationVslConfig],
  ])("%s sample validates clean", (_n, make) => {
    expect(validateWebsiteConfig(make())).toEqual({});
  });

  it("registers the three new niches", () => {
    for (const k of ["agency_consulting", "ai_consulting", "ai_automation"]) {
      expect(isNicheKey(k)).toBe(true);
      expect(NICHE_KEYS).toContain(k);
    }
  });
});

describe("addressOptional niches", () => {
  it("only the remote-first AI niches are flagged", () => {
    expect(NICHE_META.ai_consulting.addressOptional).toBe(true);
    expect(NICHE_META.ai_automation.addressOptional).toBe(true);
    expect(NICHE_META.agency_consulting.addressOptional).toBeUndefined();
    expect(NICHE_META.home_services.addressOptional).toBeUndefined();
  });

  it("does not require street/city for an AI niche", () => {
    const e = validateWebsiteConfig(aiLocal());
    expect(e["business_details.business_street"]).toBeUndefined();
    expect(e["business_details.business_city"]).toBeUndefined();
    expect(e).toEqual({});
  });

  it("still requires business name for an AI niche", () => {
    const c = aiLocal();
    c.business_details!.business_name = "";
    expect(validateWebsiteConfig(c)["business_details.business_name"]).toBe("Required.");
  });

  it("still requires street/city for a non-optional niche", () => {
    for (const make of [sampleHomeServicesLocalConfig, sampleAgencyConsultingLocalConfig]) {
      const c = make();
      c.business_details = { ...blankBusinessDetails(), business_name: "Acme" };
      const e = validateWebsiteConfig(c);
      expect(e["business_details.business_street"]).toBe("Required.");
      expect(e["business_details.business_city"]).toBe("Required.");
    }
  });

  it("rejects an unknown niche and lists the new ones", () => {
    const c = aiLocal();
    c.niche = "plumbing" as never;
    expect(validateWebsiteConfig(c).niche).toContain("ai_automation");
  });
});

describe("premium fields", () => {
  it("rejects an unknown quality and hero_motion", () => {
    const c = aiLocal();
    c.quality = "gold" as never;
    c.hero_motion = "spin" as never;
    const e = validateWebsiteConfig(c);
    expect(e.quality).toBe("Must be standard or premium.");
    expect(e.hero_motion).toBeDefined();
  });

  it("accepts the valid values", () => {
    const c = aiLocal();
    c.quality = "premium";
    c.hero_motion = "atmosphere";
    expect(validateWebsiteConfig(c)).toEqual({});
  });

  it("prefixes premium_details errors with the field path", () => {
    const c = aiLocal();
    c.premium_details = { ...blankPremiumDetails(), founded_year: "1500", metrics: "bad" };
    const e = validateWebsiteConfig(c);
    expect(e["premium_details.founded_year"]).toBeDefined();
    expect(e["premium_details.metrics"]).toBeDefined();
  });

  it("ignores niche-only premium fields once the niche changes away from them", () => {
    const c = aiLocal();
    c.premium_details = { ...blankPremiumDetails(), case_studies: "Acme", tools: "a,b,c,d,e,f,g,h,i,j,k,l,m" };
    const onNiche = validateWebsiteConfig(c);
    expect(onNiche["premium_details.case_studies"]).toBeDefined();
    expect(onNiche["premium_details.tools"]).toBeDefined();
    c.niche = null;
    const off = validateWebsiteConfig(c);
    expect(off["premium_details.case_studies"]).toBeUndefined();
    expect(off["premium_details.tools"]).toBeUndefined();
  });
});

describe("quality helpers", () => {
  it("absent or unknown quality reads as premium; only 'standard' opts out", () => {
    expect(effectiveQuality(undefined)).toBe("premium");
    expect(effectiveQuality({})).toBe("premium");
    expect(effectiveQuality({ quality: "standard" })).toBe("standard");
  });

  it("form, chat and voice follow quality and their toggles", () => {
    expect(wantsLeadForm({ quality: "premium" })).toBe(true);
    expect(wantsLeadForm({ quality: "standard" })).toBe(false);
    expect(wantsLeadForm({ quality: "premium", include_form: false })).toBe(false);
    expect(wantsChatWidget({ include_chat: false })).toBe(false);
    expect(wantsWebVoice({ include_chat: true })).toBe(true);
    expect(wantsWebVoice({ include_chat: true, include_voice: false })).toBe(false);
    expect(wantsWebVoice({ include_chat: false })).toBe(false);
  });
});
