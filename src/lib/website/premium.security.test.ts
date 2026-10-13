import { describe, expect, it } from "vitest";
import { blankPremiumDetails, sampleWebsiteConfig, type WebsiteConfig, type WebsitePremiumDetails } from "@/types/website";
import { isSafeSocialUrl, premiumDetailsPayload, validatePremiumDetails } from "./premium";
import { validateWebsiteConfig } from "./validation";

/**
 * Premium details reach a customer's PUBLIC site (social links become hrefs)
 * and arrive as untrusted JSON, so the checks here are the server boundary.
 */

const details = (over: Record<string, unknown> = {}) =>
  ({ ...blankPremiumDetails(), ...over }) as unknown as WebsitePremiumDetails;

describe("isSafeSocialUrl", () => {
  it("accepts a plain public https URL, with path, query and fragment", () => {
    for (const ok of [
      "https://instagram.com/yourbrand",
      "https://www.facebook.com/acme.gym?ref=site#top",
      "https://x.com",
      "https://example.co.za/",
    ]) {
      expect(isSafeSocialUrl(ok), ok).toBe(true);
    }
  });

  it.each([
    ["attribute breakout", 'https://a"onfocus="x'],
    ["single-quote breakout", "https://a.com/'onfocus='x"],
    ["angle bracket", "https://a.com/<script>"],
    ["backslash", "https://a.com\\@evil.com"],
    ["backtick", "https://a.com/`x`"],
    ["space", "https://a.com/x y"],
    ["tab", "https://a.com/\tx"],
    ["newline", "https://a.com/\nx"],
    ["NUL", "https://a.com/\u0000"],
    ["DEL", "https://a.com/\u007f"],
    ["http", "http://a.com"],
    ["javascript", "javascript:alert(1)"],
    ["protocol-relative", "//a.com/x"],
    ["userinfo", "https://user:pass@a.com"],
    ["username only", "https://user@a.com"],
    ["no dot in host", "https://intranet/x"],
    ["localhost", "https://localhost/x"],
    ["localhost with trailing dot", "https://localhost./x"],
    ["subdomain of localhost", "https://app.localhost/x"],
    ["IPv4 literal", "https://127.0.0.1/x"],
    ["IPv4 in hex shorthand", "https://0x7f.1/x"],
    ["IPv6 literal", "https://[::1]/x"],
    ["too long", `https://a.com/${"x".repeat(2048)}`],
    ["empty", ""],
    ["not a URL", "https://"],
  ])("refuses %s", (_label, url) => {
    expect(isSafeSocialUrl(url)).toBe(false);
  });

  it("validation refuses an unsafe link and the payload drops it", () => {
    const d = details({ social_links: 'IG | https://a"onfocus="x\nFB | https://facebook.com/acme' });
    expect(validatePremiumDetails(d, null).social_links).toBeDefined();
    expect(premiumDetailsPayload(d, null).socialLinks).toEqual([{ label: "FB", url: "https://facebook.com/acme" }]);
  });
});

describe("premium details from untrusted JSON", () => {
  it.each([
    ["tagline", 123],
    ["brand_voice", ["a"]],
    ["reference_notes", { length: 0 }],
    ["social_links", null],
    ["tools", 5],
    ["case_studies", ["Acme | Won"]],
    ["founded_year", 2011],
  ])("refuses a non-string %s instead of reading it", (field, value) => {
    const e = validatePremiumDetails(details({ [field]: value }), "ai_automation");
    expect(e).toEqual({ [field]: "Must be text." });
  });

  it("accepts the two optional fields being absent", () => {
    const d = details();
    delete (d as Partial<WebsitePremiumDetails>).tools;
    (d as Partial<WebsitePremiumDetails>).case_studies = null as unknown as undefined;
    expect(validatePremiumDetails(d, "ai_automation")).toEqual({});
  });

  it("validateWebsiteConfig refuses a premium_details that is not a plain object", () => {
    for (const bad of ["text", 7, ["tagline"], true]) {
      const c = { ...sampleWebsiteConfig(), premium_details: bad } as unknown as WebsiteConfig;
      expect(validateWebsiteConfig(c).premium_details).toBe("Must be an object.");
    }
    const ok = { ...sampleWebsiteConfig(), premium_details: blankPremiumDetails() };
    expect(validateWebsiteConfig(ok).premium_details).toBeUndefined();
  });

  it("validateWebsiteConfig keys a non-string field to premium_details.<field>", () => {
    const c = { ...sampleWebsiteConfig(), premium_details: details({ tagline: 123 }) };
    expect(validateWebsiteConfig(c)["premium_details.tagline"]).toBe("Must be text.");
  });
});

describe("concept id", () => {
  const withConcept = (concept: unknown) =>
    validateWebsiteConfig({ ...sampleWebsiteConfig(), concept } as unknown as WebsiteConfig).concept;

  it("accepts a gitpage slug, and none", () => {
    for (const ok of ["atelier", "iron-forge_2", "A".repeat(64), null, undefined]) expect(withConcept(ok)).toBeUndefined();
  });

  it("refuses anything else", () => {
    for (const bad of ["", "a".repeat(65), "../../v1/keys", "a b", "atelier?x=1", "é", 7, {}]) {
      expect(withConcept(bad), String(bad)).toBeDefined();
    }
  });
});
