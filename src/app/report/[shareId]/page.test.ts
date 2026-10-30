import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The public report page (/report/[token]), rendered to HTML through the real
 * resolver on the in-memory store: a live share renders, a dead one 404s, and
 * the "Story" layout (R3) picks its hero, "Fix these next", count and CTA from the data.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const { mem } = await import("@/test/gbp-sync-store");
const { mintReportShare, revokeReportShare } = await import("@/lib/prospecting/share");
const { default: SharedReportPage } = await import("./page");

const render = async (token: string) =>
  renderToStaticMarkup(await SharedReportPage({ params: Promise.resolve({ shareId: token }) }));

const SECTIONS = [
  { key: "gbp", status: "ok", score: 65, findings: [{ code: "gbp_no_hours", text: "No opening hours listed." }], raw: { s: "RAW-SENTINEL" } },
  { key: "lead_capture", status: "ok", score: 100, findings: [], raw: { whatsapp: true, booking: true, s: "RAW-SENTINEL" } },
  { key: "listings", status: "timeout", score: null, findings: [], reason: "The directories did not answer in time.", raw: {} },
  // Only manual-check links: never on the public page (C6).
  { key: "ads", status: "unavailable", score: null, findings: [], reason: "ADS-SENTINEL", raw: {} },
];

const AI_SECTION = {
  key: "ai_presence",
  status: "ok",
  score: 0,
  findings: [
    {
      code: "not_in_ai_answers",
      text: "AI assistants like ChatGPT and Gemini did not name the business in any of 6 answers to local searches for its services.",
      impact: "People who ask AI for a recommendation are sent to other businesses.",
      cta: "Want AI assistants to recommend your business?",
    },
  ],
  raw: {
    mentionedIn: 0,
    answersMeasured: 6,
    topCompetitors: "Alpha Plumbing, Beta Drains",
    prompts: [{ text: "best plumber in Exampletown", competitors: ["Alpha Plumbing"] }],
  },
};

function seedReport(sections: unknown[], headline: string | null = "No opening hours listed.") {
  mem.seed("prospectReports/r1", {
    agencyId: "ag1", subAccountId: "sa1", createdByUid: "u1", contactId: "c1", status: "ready", shareId: null,
    headline, generatedAt: new Date("2026-09-20T00:00:00Z"), usageMonth: "2026-09", sections,
  });
}

beforeEach(() => {
  mem.clear();
  seedReport(SECTIONS);
  mem.seed("agencies/ag1", { name: "Cresta Agency", logoUrl: "https://cdn.test/logo.png", brandColor: "#123456" });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", prospectingEnabledByAgency: true, whatsappNumber: "+27 11 000 0000" });
  mem.seed("contacts/c1", { subAccountId: "sa1", company: "Acme Plumbing" });
  mem.seed("subAccounts/sa1/bookingPages/intro", { status: "published", createdAt: new Date("2026-09-01T00:00:00Z") });
});

async function token(): Promise<string> {
  const minted = await mintReportShare({ reportId: "r1", subAccountId: "sa1", uid: "u1" });
  if (typeof minted === "string") throw new Error(minted);
  return minted.token;
}

const page = async () => render(await token());

describe("/report/[token]", () => {
  it("renders the branded report, the honest timeout, and the booking CTA", async () => {
    const html = await page();
    for (const text of ["Cresta Agency", "Acme Plumbing", "No opening hours listed.", "65<span class=\"sr-only\">/100</span>", "Timed out", "The directories did not answer in time.", 'href="/b/sa1/intro"', "WhatsApp click-to-chat", "Online booking"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('aria-label="Google Business Profile: 65 out of 100"');
    expect(html).not.toContain("RAW-SENTINEL");
    expect(html).not.toContain("ADS-SENTINEL");
  });

  it("404s for a revoked or unknown token", async () => {
    const t = await token();
    await revokeReportShare({ reportId: "r1", subAccountId: "sa1" });
    await expect(render(t)).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(render("B".repeat(43))).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("hero choice", () => {
  it("an AI-presence headline with stored questions gets the chat hook", async () => {
    seedReport([AI_SECTION, ...SECTIONS], AI_SECTION.findings[0]!.text);
    const html = await page();
    expect(html).toContain('data-testid="hero-ai"');
    expect(html).toContain("We asked AI assistants like ChatGPT and Gemini");
    expect(html).toContain("best plumber in Exampletown");
    expect(html).toContain("Alpha Plumbing, Beta Drains");
    expect(html).toContain("Acme Plumbing wasn’t mentioned.");
    expect(html).toContain('aria-label="0 of 6 AI answers named the business"');
    expect(html.match(/✕/g)).toHaveLength(6);
  });

  it("any other headline leads the same dark hero with the headline and its impact", async () => {
    seedReport([
      { ...SECTIONS[0], findings: [{ code: "gbp_no_hours", text: "No opening hours listed.", impact: "IMPACT-GBP", cta: "CTA-GBP" }] },
      // AI presence is present, with questions, but is not the headline.
      { ...AI_SECTION, score: 75, findings: [{ code: "ai_mentions_partial", text: "Named sometimes." }], raw: { ...AI_SECTION.raw, mentionedIn: 3 } },
    ]);
    const html = await page();
    expect(html).toContain('data-testid="hero-headline"');
    expect(html).not.toContain("We asked AI assistants like ChatGPT and Gemini");
    expect(html).toMatch(/<h1[^>]*>No opening hours listed\.<\/h1>/);
    expect(html).toContain("IMPACT-GBP");
  });

  it("an AI headline on a report with no stored questions (pre-R0) gets the generic hero", async () => {
    seedReport([{ ...AI_SECTION, raw: { mentionedIn: 0, answersMeasured: 6 } }], "Pre-R0 AI headline");
    const html = await page();
    expect(html).toContain('data-testid="hero-headline"');
    expect(html).toMatch(/<h1[^>]*>Pre-R0 AI headline<\/h1>/);
  });
});

describe("Fix these next, count and fallbacks", () => {
  it("lists the next three findings after the headline, by severity, with impact when stored and text alone before R0", async () => {
    seedReport([
      { key: "reputation", status: "ok", score: 35, findings: [{ code: "reviews_under_50", text: "F-REVIEWS" }, { code: "low_rating", text: "F-RATING", impact: "IMPACT-RATING" }], raw: {} },
      { key: "lead_capture", status: "ok", score: 40, findings: [{ code: "no_booking", text: "F-BOOKING" }, { code: "no_whatsapp_cta", text: "F-WHATSAPP", impact: "IMPACT-WA" }, { code: "no_chat_widget", text: "F-CHAT" }], raw: {} },
      { key: "gbp", status: "ok", score: 100, findings: [], raw: {} },
    ], "F-WHATSAPP");
    const html = await page();
    const next = html.slice(html.indexOf('data-testid="top-fixes"'), html.indexOf("The rest of your check-up"));
    // SEVERITY_ORDER: no_whatsapp_cta (the hero) < low_rating < no_booking < no_chat_widget < reviews_under_50.
    expect([...next.matchAll(/F-[A-Z]+/g)].map((m) => m[0])).toEqual(["F-RATING", "F-BOOKING", "F-CHAT"]);
    expect(next).toContain("IMPACT-RATING");
    expect(next).toContain("Fix these next");
    expect(html).toMatch(/<h1[^>]*>F-WHATSAPP<\/h1>/);
    expect(html).toMatch(/2 of 3<\/span>\s*areas need work/);
  });

  it("hides 'Fix these next' when the headline is the only finding", async () => {
    const html = await page();
    expect(html).toContain("No opening hours listed.");
    expect(html).not.toContain('data-testid="top-fixes"');
  });

  it("with no findings reads 'No major issues found' and hides 'Fix these next' and the count", async () => {
    seedReport([{ key: "gbp", status: "ok", score: 100, findings: [], raw: {} }], null);
    const html = await page();
    expect(html).toContain("No major issues found");
    expect(html).not.toContain('data-testid="top-fixes"');
    expect(html).not.toContain('data-testid="area-count"');
  });

  it("the count leaves out unscored and unmeasured sections", async () => {
    seedReport([
      ...SECTIONS,
      { key: "listings", status: "ok", score: null, findings: [], raw: { checks: [] } },
    ]);
    // Scored: gbp (finding) and lead_capture. Listings (unscored), timeout and ads are not areas.
    expect(await page()).toMatch(/1 of 2<\/span>\s*areas need work/);
  });
});

describe("CTA and brand", () => {
  it("uses the headline finding's stored CTA line, and a generic one without it", async () => {
    seedReport([AI_SECTION, ...SECTIONS], AI_SECTION.findings[0]!.text);
    expect(await page()).toContain("Want AI assistants to recommend your business?");
    seedReport(SECTIONS);
    expect(await page()).toContain("Want help fixing these?");
  });

  it("the WhatsApp button links wa.me, and is hidden with no number; the booking button is hidden with no page", async () => {
    expect(await page()).toContain('href="https://wa.me/27110000000"');
    mem.seed("subAccounts/sa1", { agencyId: "ag1", prospectingEnabledByAgency: true });
    const noWa = await page();
    expect(noWa).not.toContain("wa.me");
    expect(noWa).not.toContain("WhatsApp us");
    expect(noWa).toContain("Book a call");
    await mem.db.doc("subAccounts/sa1/bookingPages/intro").delete();
    mem.seed("subAccounts/sa1", { agencyId: "ag1", prospectingEnabledByAgency: true, whatsappNumber: "+27110000000" });
    const waOnly = await page();
    expect(waOnly).toContain('data-testid="report-cta"');
    expect(waOnly).toContain("WhatsApp us");
    expect(waOnly).not.toContain("Book a call");
    mem.seed("subAccounts/sa1", { agencyId: "ag1", prospectingEnabledByAgency: true });
    const neither = await page();
    expect(neither).not.toContain("Book a call");
    expect(neither).not.toContain('data-testid="report-cta"');
  });

  it("pins the light scheme whatever the device theme", async () => {
    expect(await page()).toMatch(/<main class="light [^"]*" style="[^"]*color-scheme:light/);
  });

  it("sets the agency brand colour as a CSS variable, falling back to the default for an unusable one", async () => {
    expect(await page()).toContain("--report-brand:#123456");
    mem.seed("agencies/ag1", { name: "Cresta Agency", brandColor: "#FFFF00" });
    expect(await page()).toContain("--report-brand:#2563EB");
  });

  it("traffic-light colours ignore the brand: a poor score is always #9F1D1D, a good one #1E874B", async () => {
    seedReport([{ ...SECTIONS[0], score: 20 }, SECTIONS[1]]);
    for (const brand of ["#123456", "#1E874B"]) {
      mem.seed("agencies/ag1", { name: "Cresta Agency", brandColor: brand });
      const html = await page();
      const gbp = html.slice(html.indexOf('data-testid="report-section-gbp"'));
      expect(gbp.slice(0, gbp.indexOf("</li>"))).toContain('stroke="#9F1D1D"');
      expect(gbp.slice(0, gbp.indexOf("</li>"))).toContain('style="color:#9F1D1D;border-color:#9F1D1D">Poor');
      const lead = html.slice(html.indexOf('data-testid="report-section-lead_capture"'));
      expect(lead.slice(0, lead.indexOf("</li>"))).toContain('stroke="#1E874B"');
    }
  });
});

