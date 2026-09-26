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
    const res = await get(await mint());
    expect(res.status).toBe(200);
    const text = await res.clone().text();
    const body = (await res.json()) as Record<string, unknown> & { sections: Record<string, unknown>[] };
    expect(Object.keys(body).sort()).toEqual(["agency", "businessName", "cta", "generatedAt", "headline", "sections"]);
    for (const s of body.sections) {
      expect(Object.keys(s).sort()).toEqual(["details", "findings", "key", "reason", "score", "status"]);
    }
    expect(body).toMatchObject({
      businessName: "Acme Plumbing",
      headline: "No opening hours on Google",
      generatedAt: "2026-09-20T00:00:00.000Z",
      agency: { name: "Cresta Agency", logoUrl: "https://cdn.test/logo.png", appTheme: "green" },
      cta: "/b/sa1/first",
    });
    expect(body.sections[1]).toEqual({ key: "ads", status: "unavailable", score: null, findings: [], reason: "No ad library source", details: {} });
    for (const leak of ["RAW-SENTINEL", "UID-SENTINEL", "OWNER-SENTINEL", "EMAIL-SENTINEL", "PHONE-SENTINEL", "\"raw\"", "createdByUid", "agencyId", "subAccountId", "contactId", "usageMonth", "cost"]) {
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
      { rating: 4.2, reviewsCount: 12, velocity90d: "notMeasured" },
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
