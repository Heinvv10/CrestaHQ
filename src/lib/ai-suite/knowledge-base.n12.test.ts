import { describe, expect, it } from "vitest";
import { AI_SUITE_KNOWLEDGE } from "./knowledge-base";
import { retrieveKnowledge } from "./retrieve";

const IDS = [
  "calendar-sync",
  "checkout-pages",
  "meta-connection",
  "voice-agent",
  "outbound-voice",
  "phone-dialer",
  "webinars",
  "sms-whatsapp-setup",
  "web-chat",
  "web-voice",
  "funnels-labs",
  "phone-region",
  "your-account",
  "which-key-powers-what",
  "data-ownership-backups",
] as const;

function card(id: string) {
  return AI_SUITE_KNOWLEDGE.find((candidate) => candidate.id === id)!;
}

function retrieved(query: string, level: "sub-account" | "agency") {
  return retrieveKnowledge(query, level);
}

describe("N12 knowledge cards", () => {
  it("adds every requested card exactly once with usable content", () => {
    for (const id of IDS) {
      const matches = AI_SUITE_KNOWLEDGE.filter(
        (candidate) => candidate.id === id
      );
      expect(matches, id).toHaveLength(1);
      expect(matches[0].levels.length, id).toBeGreaterThan(0);
      expect(matches[0].location.length, id).toBeGreaterThan(5);
      expect(matches[0].keywords.length, id).toBeGreaterThan(4);
      expect(matches[0].body.length, id).toBeGreaterThan(120);
    }
  });

  it.each([
    ["connect google calendar busy times", "sub-account", "calendar-sync"],
    ["sell with checkout order bumps", "sub-account", "checkout-pages"],
    ["connect facebook instagram page", "agency", "meta-connection"],
    ["inbound voice receptionist", "sub-account", "voice-agent"],
    ["outbound voice campaign", "agency", "outbound-voice"],
    ["browser phone dialer", "sub-account", "phone-dialer"],
    ["connect webinar1", "agency", "webinars"],
    ["whatsapp linked device bridge", "sub-account", "sms-whatsapp-setup"],
    ["web chat allowed domains", "sub-account", "web-chat"],
    ["elevenlabs microphone", "agency", "web-voice"],
    ["quick funnel lead magnet", "sub-account", "funnels-labs"],
    ["default phone country e164", "sub-account", "phone-region"],
    ["change my password appearance", "sub-account", "your-account"],
    ["which api key powers resend smtp", "agency", "which-key-powers-what"],
    ["backup firebase auth storage bridge", "agency", "data-ownership-backups"],
  ] as const)("retrieves %s for the permitted level", (query, level, id) => {
    expect(
      retrieveKnowledge(query, level).map((result) => result.id)
    ).toContain(id);
  });

  it("states the Cresta gate defaults instead of the upstream Calendar and dialer assumptions", () => {
    expect(card("calendar-sync").body).toContain(
      "explicitly enable Calendar sync"
    );
    expect(card("calendar-sync").body).toContain("off by default");
    expect(card("phone-dialer").body).toContain("off by default");
    expect(card("web-voice").body).toContain("off by default");
    expect(card("web-chat").body).toContain("on by default");
    expect(card("voice-agent").body).toContain("on by default");
    expect(card("calendar-sync").body).not.toContain(
      "There is no per-sub-account gate"
    );
  });

  it("keeps Checkout and Quick Funnels on Stripe and identifies Paystack payment links as separate", () => {
    for (const id of ["checkout-pages", "funnels-labs"] as const) {
      expect(card(id).body).toContain("Stripe");
      expect(card(id).body).toContain("Paystack");
      expect(card(id).body).toContain("separate");
    }
    expect(card("checkout-pages").body).toContain("ZAR Paystack payment links");
  });

  it("describes all three WhatsApp rails without promising bridge templates or a service window", () => {
    const body = card("sms-whatsapp-setup").body;
    for (const rail of ["Twilio", "Meta Cloud", "bridge"])
      expect(body).toContain(rail);
    expect(body).toContain("no approved-template flow");
    expect(body).toContain("does not use Meta's 24-hour service-window rule");
    expect(body).not.toContain("WhatsApp is delivered through Twilio only");
    expect(body).not.toContain("Cloud API) isn't available");
  });

  it("separates current email, voice and payment credential scopes", () => {
    const body = card("which-key-powers-what").body;
    for (const fact of [
      "verified SMTP",
      "Resend sending domain",
      "shared fallback",
      "PLATFORM_SMTP_*",
      "mailbox sync",
      "own ElevenLabs key",
      "ZAR invoice payment links",
      "BILLING_PROVIDER=paystack",
    ])
      expect(body).toContain(fact);
    expect(body).not.toContain("RESEND + EMAIL_FROM — every email");
    expect(body).not.toContain(
      "TWILIO — shared env keys or each workspace's own account: SMS, the WhatsApp sender"
    );
  });

  it.each([
    "send invoice email with smtp",
    "does invoice sending require resend",
  ])("keeps invoice email guidance consistent for: %s", (query) => {
    const results = retrieved(query, "sub-account");
    expect(results.map((result) => result.id)).toContain("quotes-invoices");
    const guidance = results.map((result) => result.body).join("\n");
    expect(guidance).toContain("verified SMTP provider when selected");
    expect(guidance).toContain("verified Resend sending domain");
    expect(guidance).toContain("shared Resend sender as the fallback");
    expect(guidance).not.toMatch(/sending requires Resend/i);
  });

  it.each([
    "can client billing use paystack",
    "set up paystack client billing",
  ])("keeps Client Billing provider guidance consistent for: %s", (query) => {
    const results = retrieved(query, "agency");
    expect(results.map((result) => result.id)).toContain(
      "agency-client-billing"
    );
    const billing = results.find(
      (result) => result.id === "agency-client-billing"
    )!.body;
    expect(billing).toContain("PAYSTACK_SECRET_KEY");
    expect(billing).toContain("BILLING_PROVIDER=paystack");
    expect(billing).toContain("ZAR plans");
    const guidance = results.map((result) => result.body).join("\n");
    expect(guidance).toContain("PAYSTACK_SECRET_KEY");
    expect(guidance).toContain("BILLING_PROVIDER=paystack");
    expect(guidance).toContain("ZAR");
    expect(guidance).toContain("separate");
    expect(guidance).not.toMatch(
      /requires Stripe|through your own Stripe account/i
    );
  });

  it("retrieves consistent Twilio, Vapi and WhatsApp number guidance", () => {
    const results = retrieved(
      "set up sms whatsapp and inbound voice phone number",
      "sub-account"
    );
    expect(results.map((result) => result.id)).toContain("sms-whatsapp-setup");
    expect(results.map((result) => result.id)).toContain("voice-agent");
    expect(card("sms-whatsapp-setup").body).toContain(
      "Twilio number or a Vapi-managed number"
    );
    const guidance = results.map((result) => result.body).join("\n");
    expect(guidance).toContain("SMS and the browser dialer are Twilio-only");
    expect(guidance).toContain("Twilio number or a Vapi-managed number");
    expect(guidance).not.toContain("phone calling remain Twilio-only");
  });

  it("describes strict and lenient phone parsing without a blanket E.164 guarantee", () => {
    const body = card("phone-region").body;
    expect(body).toContain("Public forms validate strictly");
    expect(body).toContain("otherwise preserve the raw value");
    expect(body).toContain("cannot guarantee E.164");
    expect(body).not.toContain("Those numbers are stored in E.164 format");
  });

  it("keeps tenant payment rails and Webinar1 video timing exact", () => {
    const keys = card("which-key-powers-what").body;
    expect(keys).toContain("ZAR invoice payment links");
    expect(keys).toContain("card-on-file recurring links");
    expect(keys).toContain("Stripe powers Checkout, Quick Funnels");
    expect(keys).toContain(
      "agency Client Billing, separately from both tenant rails"
    );
    expect(card("webinars").body).toContain(
      "already processed video or lets you attach the video later in Webinar1 admin"
    );
  });

  it("does not overstate backup completeness or live provider verification", () => {
    const ownership = card("data-ownership-backups").body;
    for (const store of [
      "Firestore",
      "Firebase Authentication",
      "Firebase Storage",
      "provider",
      "SQLite",
    ]) {
      expect(ownership).toContain(store);
    }
    expect(ownership).toContain("not a complete deployment backup");
    expect(ownership).not.toContain(
      "All data lives in YOUR OWN Firebase project"
    );
    expect(ownership).not.toContain("template's author holds none");
    expect(card("phone-dialer").body).toContain("not been runtime-verified");
    expect(card("web-voice").body).toContain("not been runtime-verified");
    expect(card("web-voice").body).not.toMatch(/\$\d|per minute/i);
  });
});
