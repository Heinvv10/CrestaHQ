import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/public/prospecting/report/[token] — the public share JSON. Shares
 * are minted and revoked through the real share lib on the in-memory store;
 * every refusal must be indistinguishable, and the payload a strict whitelist.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

const { mem } = await import("@/test/gbp-sync-store");
const { mintReportShare, revokeReportShare } = await import("@/lib/prospecting/share");
const { GET } = await import("./route");
const { apexgeoFromScan, apexgeoPlaceholders, APEXGEO_REASON } = await import("@/lib/prospecting/apexgeo-sections");
const { completedScan } = await import("@/lib/prospecting/apexgeo.fixture");

const get = (token: string) =>
  GET(new Request(`https://app.test/api/public/prospecting/report/${token}`), { params: Promise.resolve({ shareId: token }) });

const SECTIONS = [
  {
    key: "gbp", status: "ok", score: 60,
    findings: [{ code: "gbp_no_hours", text: "Your profile lists no opening hours." }],
    raw: { secretRaw: "RAW-SENTINEL", rating: 4.2 },
  },
  { key: "ads", status: "unavailable", score: null, findings: [], reason: "No ad library source", raw: { x: 1 } },
];

function seed(extra: Record<string, unknown> = {}) {
  mem.seed("prospectReports/r1", {
    agencyId: "ag1", subAccountId: "sa1", createdByUid: "UID-SENTINEL", contactId: "c1",
    status: "ready", sections: SECTIONS, headline: "No opening hours on Google", shareId: null,
    generatedAt: new Date("2026-09-20T00:00:00Z"), createdAt: new Date("2026-09-20T00:00:00Z"),
    usageMonth: "2026-09", cost: { http: 3 },
    ...extra,
  });
}

async function mint(): Promise<string> {
  const minted = await mintReportShare({ reportId: "r1", subAccountId: "sa1", uid: "UID-SENTINEL" });
  if (typeof minted === "string") throw new Error(minted);
  return minted.token;
}

async function snapshot(res: Response) {
  return { status: res.status, body: await res.text(), headers: [...res.headers.entries()] };
}

beforeEach(() => {
  mem.clear();
  seed();
  mem.seed("agencies/ag1", { name: "Cresta Agency", logoUrl: "https://cdn.test/logo.png", appTheme: "green", ownerUid: "OWNER-SENTINEL" });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", prospectingEnabledByAgency: true });
  mem.seed("contacts/c1", { subAccountId: "sa1", name: "Acme", company: "Acme Plumbing", email: "EMAIL-SENTINEL@x.test", phone: "PHONE-SENTINEL" });
  mem.seed("subAccounts/sa1/bookingPages/later", { status: "published", createdAt: new Date("2026-09-10T00:00:00Z") });
  mem.seed("subAccounts/sa1/bookingPages/first", { status: "published", createdAt: new Date("2026-09-01T00:00:00Z") });
  mem.seed("subAccounts/sa1/bookingPages/draft", { status: "draft", createdAt: new Date("2026-08-01T00:00:00Z") });
});

describe("a live share", () => {
  it("returns exactly the whitelisted payload", async () => {
    // A settled mystery shop to the contact's own address: its outcome is public, its target is not.
    mem.seed("mysteryShops/s1", {
      agencyId: "ag1", subAccountId: "sa1", contactId: "c1", channel: "email", target: "EMAIL-SENTINEL@x.test",
      status: "missed", sentAt: new Date("2026-10-08T08:00:00Z"), jobValueCents: 150_000, currency: "ZAR",
      missedConfirmedAt: new Date("2026-10-09T08:00:00Z"),
      enquiryText: "ENQUIRY-SENTINEL", providerRef: "REF-SENTINEL", createdByUid: "UID-SENTINEL",
    });
    const res = await get(await mint());
    expect(res.status).toBe(200);
    const text = await res.clone().text();
    const body = (await res.json()) as Record<string, unknown> & { sections: Record<string, unknown>[] };
    expect(Object.keys(body).sort()).toEqual(["agency", "businessName", "cta", "generatedAt", "headline", "mysteryShop", "sections", "whatsappNumber"]);
    for (const s of body.sections) {
      expect(Object.keys(s).sort()).toEqual(["details", "findings", "key", "reason", "reasonCode", "score", "status"]);
    }
    expect(body).toMatchObject({
      businessName: "Acme Plumbing",
      headline: "No opening hours on Google",
      generatedAt: "2026-09-20T00:00:00.000Z",
      agency: { name: "Cresta Agency", logoUrl: "https://cdn.test/logo.png", appTheme: "green", brandColor: "#2563EB" },
      cta: "/b/sa1/first",
      whatsappNumber: null,
    });
    // The ads section is only manual-check links: never public (C6).
    expect(body.sections.map((s) => s.key)).toEqual(["gbp"]);
    expect((body.mysteryShop as { items: { text: string }[] }[])[0].items[0].text).toMatch(/R1,500 lead missed/);
    for (const leak of ["RAW-SENTINEL", "UID-SENTINEL", "OWNER-SENTINEL", "EMAIL-SENTINEL", "PHONE-SENTINEL", "ENQUIRY-SENTINEL", "REF-SENTINEL", "\"raw\"", "createdByUid", "agencyId", "subAccountId", "contactId", "usageMonth", "cost"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("cta is null when no booking page is published", async () => {
    mem.clear();
    seed();
    mem.seed("subAccounts/sa1", { agencyId: "ag1", prospectingEnabledByAgency: true });
    mem.seed("contacts/c1", { subAccountId: "sa1", company: "Acme Plumbing" });
    const body = (await (await get(await mint())).json()) as { cta: unknown };
    expect(body.cta).toBeNull();
  });
});

describe("section details", () => {
  it("pass only whitelisted scalar raw keys", async () => {
    mem.seed("prospectReports/r1", {
      ...mem.read("prospectReports/r1"),
      sections: [
        { key: "business_details", status: "ok", score: 50, findings: [], raw: { name: "Acme", website: "https://acme.test", category: "Plumber", https: true, phone: "PHONE-RAW", address: "ADDR-RAW" } },
        { key: "reputation", status: "ok", score: 70, findings: [], raw: { rating: 4.2, reviewsCount: 12, velocity90d: "notMeasured" } },
        { key: "lead_capture", status: "ok", score: 40, findings: [], raw: { whatsapp: false, booking: true, contactForm: { nested: 1 } } },
        { key: "listings", status: "ok", score: 30, findings: [], raw: { checks: [{ directory: "x" }] } },
      ],
    });
    const body = (await (await get(await mint())).json()) as { sections: { details: unknown }[] };
    expect(body.sections.map((s) => s.details)).toEqual([
      { name: "Acme", website: "https://acme.test", category: "Plumber", https: true },
      { rating: 4.2, reviewsCount: 12 },
      { whatsapp: false, booking: true },
      {},
    ]);
  });
});

describe("the business name (L1)", () => {
  const bd = { key: "business_details", status: "ok", score: 50, findings: [], raw: { name: "Jane Private", category: "Plumber" } };

  it("a person's name on a non-prospecting contact without a company is never published", async () => {
    mem.seed("contacts/c1", { subAccountId: "sa1", name: "Jane Private", company: "" });
    seed({ sections: [bd] });
    const res = await get(await mint());
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("Jane Private");
    expect(JSON.parse(text)).toMatchObject({ businessName: null, sections: [{ details: { category: "Plumber" } }] });
  });

  it("the ads section, whose Meta Ad Library link searches by that name (NEW-L1), never reaches the public page (C6)", async () => {
    mem.seed("contacts/c1", { subAccountId: "sa1", name: "Jane Private", company: "" });
    const ads = {
      key: "ads", status: "unavailable", score: null, findings: [], reason: "check manually",
      raw: {
        metaAdLibraryUrl: "https://www.facebook.com/ads/library/?q=Jane%20Private",
        googleAdsTransparencyUrl: "https://adstransparency.google.com/?region=ZA&domain=example.com",
      },
    };
    seed({ sections: [ads] });
    const text = await (await get(await mint())).text();
    expect(text).not.toContain("Jane");
    expect(text).not.toContain("adstransparency");
    expect(JSON.parse(text).sections).toEqual([]);
  });

  it("a prospecting import's name is the business name", async () => {
    mem.seed("contacts/c1", { subAccountId: "sa1", name: "Jane's Bakery", company: "", source: "prospecting" });
    seed({ sections: [{ ...bd, raw: { name: "Jane's Bakery" } }] });
    const body = (await (await get(await mint())).json()) as { businessName: string; sections: { details: unknown }[] };
    expect(body.businessName).toBe("Jane's Bakery");
    expect(body.sections[0]!.details).toEqual({ name: "Jane's Bakery" });
  });
});

describe("non-enumeration", () => {
  it("unknown, malformed, revoked, not-ready and tenancy-mismatched tokens are byte-identical 404s", async () => {
    const unknown = await snapshot(await get("A".repeat(43)));
    expect(unknown.status).toBe(404);

    const cases: Record<string, () => Promise<Response>> = {
      malformed: () => get("not a token!"),
      short: () => get("abc"),
      revoked: async () => {
        const t = await mint();
        await revokeReportShare({ reportId: "r1", subAccountId: "sa1" });
        return get(t);
      },
      "not ready": async () => {
        const t = await mint();
        mem.seed("prospectReports/r1", { ...mem.read("prospectReports/r1"), status: "running" });
        return get(t);
      },
      "report deleted": async () => {
        const t = await mint();
        await mem.db.doc("prospectReports/r1").delete();
        return get(t);
      },
      "gate off (L3)": async () => {
        const t = await mint();
        mem.seed("subAccounts/sa1", { agencyId: "ag1", prospectingEnabledByAgency: false });
        return get(t);
      },
      "gate field missing (L3)": async () => {
        const t = await mint();
        mem.seed("subAccounts/sa1", { agencyId: "ag1" });
        return get(t);
      },
      "contact deleted (L3)": async () => {
        const t = await mint();
        await mem.db.doc("contacts/c1").delete();
        return get(t);
      },
      "tenancy mismatch": async () => {
        const t = await mint();
        mem.seed("prospectReports/r1", { ...mem.read("prospectReports/r1"), subAccountId: "sa2" });
        return get(t);
      },
    };
    for (const [label, make] of Object.entries(cases)) {
      mem.clear();
      seed();
      mem.seed("subAccounts/sa1", { agencyId: "ag1", prospectingEnabledByAgency: true });
      mem.seed("contacts/c1", { subAccountId: "sa1", company: "Acme Plumbing" });
      expect({ label, ...(await snapshot(await make())) }).toEqual({ label, ...unknown });
    }
  });

  it("a share stamped revoked is dead even while the report still points at it", async () => {
    const t = await mint();
    const shareId = mem.read("prospectReports/r1")?.shareId as string;
    mem.seed(`prospectReportShares/${shareId}`, { ...mem.read(`prospectReportShares/${shareId}`), revokedAt: new Date() });
    expect(mem.read("prospectReports/r1")?.shareId).toBe(shareId);
    expect(await snapshot(await get(t))).toEqual(await snapshot(await get("A".repeat(43))));
  });

  it("a revoked token stays dead after a re-mint; only the new one works", async () => {
    const old = await mint();
    const fresh = await mint();
    expect((await get(old)).status).toBe(404);
    expect((await get(fresh)).status).toBe(200);
  });
});

describe("ApexGEO sections (decision D6)", () => {
  const keysOf = async () =>
    ((await (await get(await mint())).json()) as { sections: { key: string; status: string; reasonCode: string | null }[] })
      .sections;

  it("not connected: the three sections are absent from the public page", async () => {
    seed({ sections: [...SECTIONS, ...apexgeoPlaceholders("not_connected", APEXGEO_REASON.not_connected)] });
    const text = await (await get(await mint())).clone().text();
    expect(JSON.parse(text).sections.map((s: { key: string }) => s.key)).toEqual(["gbp"]);
    expect(text).not.toContain("ApexGEO key");
  });

  it("out of ApexGEO credits: also the agency's setup, also hidden", async () => {
    seed({ sections: [...SECTIONS, ...apexgeoPlaceholders("out_of_credits", APEXGEO_REASON.out_of_credits)] });
    expect((await keysOf()).map((s) => s.key)).toEqual(["gbp"]);
  });

  it.each(["pending", "timeout", "failed", "missing_input"] as const)(
    "%s sections stay on the public page, honestly",
    async (code) => {
      seed({ sections: [...SECTIONS, ...apexgeoPlaceholders(code, "some reason")] });
      const sections = await keysOf();
      expect(sections.map((s) => s.key)).toEqual(["gbp", "website_performance", "ai_readiness", "ai_presence"]);
      expect(sections[1].reasonCode).toBe(code);
    },
  );

  it.each(["pending", "timeout", "failed"] as const)("a %s section's public reason never names the vendor (white-label)", async (code) => {
    seed({ sections: [...SECTIONS, ...apexgeoPlaceholders(code, APEXGEO_REASON[code])] });
    const text = await (await get(await mint())).text();
    expect(text).toContain(APEXGEO_REASON[code]);
    expect(text).not.toMatch(/apexgeo/i);
  });

  it("filled sections show counts and competitor names, never answer text, cited URLs or provider errors", async () => {
    const scan = completedScan();
    scan.ai_visibility.prompts[0].engines[0].cited_url = "https://cited.example/page";
    seed({ sections: [...SECTIONS, ...apexgeoFromScan(scan as never)] });
    const res = await get(await mint());
    const text = await res.clone().text();
    const body = (await res.json()) as { sections: { key: string; details: Record<string, unknown> }[] };
    expect(body.sections.find((s) => s.key === "ai_presence")?.details).toEqual({
      mentionedIn: 0, answersMeasured: 6,
      topCompetitors: "Alpha Plumbing, Beta Drains, Gamma Plumbing Exampletown",
      question1: "best plumber in Exampletown",
      question2: "plumber near me in Exampletown, who should I call",
      question3: "recommended plumber Exampletown reviews",
    });
    // The question text is public (C7); model ids (C4) and per-question competitor lists are not.
    for (const leak of ["cited.example", "gemini-2.5", "gpt-4o", "sonar", "Delta Plumbquick", "insufficient_quota", "perplexity.ai", "No FAQ Schema", "WebPage"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("a scan pending for over 30 minutes shows as timed out, not in progress forever", async () => {
    seed({
      sections: [...SECTIONS, ...apexgeoPlaceholders("pending", APEXGEO_REASON.pending)],
      apexgeo: { scanId: "s1", status: "pending", attempts: 2, startedAt: new Date(Date.now() - 31 * 60_000) },
    });
    const sections = await keysOf();
    expect(sections.slice(1).map((s) => [s.status, s.reasonCode])).toEqual(Array(3).fill(["timeout", "timeout"]));
  });

  it("a scan pending for under 30 minutes is still in progress", async () => {
    seed({
      sections: [...SECTIONS, ...apexgeoPlaceholders("pending", APEXGEO_REASON.pending)],
      apexgeo: { scanId: "s1", status: "pending", attempts: 2, startedAt: new Date(Date.now() - 29 * 60_000) },
    });
    expect((await keysOf())[1].reasonCode).toBe("pending");
  });
});

describe("hidden rows (C6) and unexplained scores", () => {
  const listings = {
    key: "listings", status: "ok", score: null, findings: [],
    raw: { checks: [
      { directory: "Facebook", url: null, status: "found" },
      { directory: "Bing", url: null, status: "not_found" },
      { directory: "Brabys", url: null, status: "unknown" },
    ] },
  };
  const reputation = {
    key: "reputation", status: "ok", score: 85, findings: [],
    raw: { rating: 4.6, reviewsCount: 37, velocity90d: "notMeasured", ownerReplyRate: "notMeasured" },
  };
  const gbp = { key: "gbp", status: "ok", score: 100, findings: [], raw: { details: {}, description: "notMeasured" } };
  const ads = {
    key: "ads", status: "unavailable", score: null, findings: [], reason: "check manually",
    raw: { metaAdLibraryUrl: "https://www.facebook.com/ads/library/?q=Acme", googleAdsTransparencyUrl: null },
  };
  const sections = [listings, reputation, gbp, ads, ...apexgeoFromScan(completedScan() as never)];

  it("the JSON route carries no not-measured, could-not-check, not-found or manual-check row, and no ads section", async () => {
    seed({ sections });
    const text = await (await get(await mint())).text();
    const body = JSON.parse(text) as { sections: { key: string; details: Record<string, unknown> }[] };
    expect(body.sections.map((s) => s.key)).not.toContain("ads");
    expect(body.sections.find((s) => s.key === "listings")?.details).toEqual({ Facebook: "found" });
    expect(body.sections.find((s) => s.key === "reputation")?.details).toEqual({ rating: 4.6, reviewsCount: 37 });
    expect(body.sections.find((s) => s.key === "gbp")?.details).not.toHaveProperty("description");
    for (const hidden of ["notMeasured", "not_found", "unknown", "ads/library", "adstransparency", "check manually"]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("a score below 100 with no finding is dropped; one with a finding, or 100, is kept", async () => {
    seed({ sections: [reputation, gbp, SECTIONS[0]] });
    const body = (await (await get(await mint())).json()) as { sections: { key: string; score: number | null }[] };
    expect(body.sections.map((s) => [s.key, s.score])).toEqual([["reputation", null], ["gbp", 100], ["gbp", 60]]);
  });

  it("the member view keeps every hidden row, the ads section and the models (serializeReport)", async () => {
    const { serializeReport } = await import("@/lib/prospecting/reports");
    const member = serializeReport("r1", { ...mem.read("prospectReports/r1"), sections });
    const text = JSON.stringify(member);
    expect(member.sections.map((s) => s.key)).toContain("ads");
    expect(member.sections.find((s) => s.key === "listings")?.details).toEqual({ Facebook: "found", Bing: "not_found", Brabys: "unknown" });
    expect(member.sections.find((s) => s.key === "reputation")).toMatchObject({ score: 85, details: { velocity90d: "notMeasured" } });
    expect(member.sections.find((s) => s.key === "ai_presence")?.details.models).toBe("gemini-2.5-flash, gpt-4o-mini");
    expect(text).toContain("ads/library");
  });
});
