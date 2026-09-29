import { inflateSync } from "node:zlib";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportStory } from "@/lib/prospecting/report-story";

/**
 * GET /report/[token]/pdf (R5) through the real resolver on the in-memory
 * store and the real react-pdf renderer. The document component is wrapped
 * only to record what it was handed; publicFetch is stubbed (no network).
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const fed = vi.hoisted(() => ({ props: [] as { story: ReportStory; logo: string | null; bookUrl: string | null }[] }));
vi.mock("@/lib/prospecting/report-pdf-document", async (orig) => {
  const real = await orig<typeof import("@/lib/prospecting/report-pdf-document")>();
  return {
    ReportPdfDocument: (props: (typeof fed.props)[number]) => {
      fed.props.push(props);
      return real.ReportPdfDocument(props);
    },
  };
});

// A 1×1 PNG, served for the logo URL only.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const fetched = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("@/lib/webhooks/public-fetch", () => ({
  publicFetch: async (url: string) => {
    fetched.urls.push(url);
    return new Response(new Uint8Array(PNG), { status: 200 });
  },
}));

const { mem } = await import("@/test/gbp-sync-store");
const { mintReportShare, revokeReportShare } = await import("@/lib/prospecting/share");
const { resolvePublicReport } = await import("@/lib/prospecting/public-report");
const { reportStory } = await import("@/lib/prospecting/report-story");
const { LABELS } = await import("@/lib/prospecting/report-rows");
const { PDF_IP_LIMIT, PDF_SHARE_LIMIT } = await import("@/lib/prospecting/pdf-rate-limit");
const { GET } = await import("./route");
const { default: SharedReportPage } = await import("../page");

let ipSeq = 0;
/** A fresh client IP per call unless one is given: the IP limit is module state. */
const call = (token: string, ip = `198.51.100.${++ipSeq}`) =>
  GET(new Request(`http://x/report/${token}/pdf`, { headers: { "x-forwarded-for": ip } }), {
    params: Promise.resolve({ shareId: token }),
  });

const WIN_ANSI = new TextDecoder("windows-1252");

/**
 * The text drawn on the PDF's pages (react-pdf writes WinAnsi hex strings in
 * TJ arrays), whitespace removed: a line wrap or a nested <Text> splits a
 * sentence across arrays, so assertions compare `squash(expected)`.
 */
function pdfText(bytes: Buffer): string {
  const raw = bytes.toString("latin1");
  const streams: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    try {
      streams.push(inflateSync(bytes.subarray(start, raw.indexOf("endstream", start))).toString("latin1"));
    } catch {
      // Not a Flate stream (an image, or font data): carries no page text.
      continue;
    }
  }
  return [...streams.join("\n").matchAll(/\[(.*?)\]\s*TJ/g)]
    .map((x) => [...x[1]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => WIN_ANSI.decode(Buffer.from(h[1]!, "hex"))).join(""))
    .join("")
    .replace(/\s+/g, "");
}

const squash = (t: string) => t.replace(/\s+/g, "");

const SECTIONS = [
  {
    key: "ai_presence", status: "ok", score: 0,
    findings: [{ code: "not_in_ai_answers", text: "Not named by AI.", impact: "IMPACT-AI", cta: "CTA-AI" }],
    raw: { mentionedIn: 0, answersMeasured: 6, topCompetitors: "Alpha Pipes", models: ["gemini-2.5-flash", "gpt-4o"], prompts: [{ text: "best plumber in Exampletown" }] },
  },
  {
    key: "website_performance", status: "ok", score: 30,
    findings: [{ code: "slow_mobile", text: "Slow on a phone.", impact: "IMPACT-SLOW", cta: null }],
    raw: { lcpSeconds: 9.8, speedIndexSeconds: 777.7, fcpSeconds: 888.8, tbtMs: 999, cls: 0.555, mobileViewport: true },
  },
  { key: "gbp", status: "ok", score: 65, findings: [{ code: "gbp_no_hours", text: "No opening hours listed." }], raw: { s: "RAW-SENTINEL" } },
  { key: "ads", status: "unavailable", score: null, findings: [], reason: "ADS-SENTINEL", raw: {} },
  { key: "ai_readiness", status: "unavailable", score: null, findings: [], reason: "NOT-CONNECTED-SENTINEL", reasonCode: "not_connected", raw: {} },
  { key: "listings", status: "ok", score: null, findings: [], raw: { checks: [{ directory: "Cylex", status: "not_found" }] } },
];

function seedReport(sections: unknown[]) {
  mem.seed("prospectReports/r1", {
    agencyId: "ag1", subAccountId: "sa1", createdByUid: "u1", contactId: "c1", status: "ready", shareId: null,
    headline: "Not named by AI.", generatedAt: new Date("2026-09-20T00:00:00Z"), usageMonth: "2026-09", sections,
  });
}

beforeEach(() => {
  mem.clear();
  fed.props.length = 0;
  fetched.urls.length = 0;
  process.env.NEXT_PUBLIC_APP_URL = "https://crm.example.test";
  seedReport(SECTIONS);
  mem.seed("agencies/ag1", { name: "Example Agency", logoUrl: "https://cdn.test/logo.png", brandColor: "#0F766E" });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", prospectingEnabledByAgency: true, whatsappNumber: "+27000000000" });
  mem.seed("contacts/c1", { subAccountId: "sa1", company: "Example Plumbing Co" });
  mem.seed("subAccounts/sa1/bookingPages/intro", { status: "published", createdAt: new Date("2026-09-01T00:00:00Z") });
});

async function token(): Promise<string> {
  const minted = await mintReportShare({ reportId: "r1", subAccountId: "sa1", uid: "u1" });
  if (typeof minted === "string") throw new Error(minted);
  return minted.token;
}

describe("GET /report/[token]/pdf", () => {
  it("200s with an A4 PDF attachment, not cached, carrying the report's text", async () => {
    const res = await call(await token());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="report-example-plumbing-co.pdf"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const text = pdfText(bytes);
    for (const t of ["Example Agency", "Example Plumbing Co wasn’t mentioned.", "3 of 3", "Slow on a phone.", "IMPACT-SLOW", "best plumber in Exampletown", "CTA-AI", "Book a call: https://crm.example.test/b/sa1/intro", "WhatsApp us: +27000000000"]) {
      expect(text).toContain(squash(t));
    }
  });

  it("404s for a revoked or unknown token, as the page does", async () => {
    const t = await token();
    expect((await call(t)).status).toBe(200);
    await revokeReportShare({ reportId: "r1", subAccountId: "sa1" });
    expect((await call(t)).status).toBe(404);
    expect((await call("B".repeat(43))).status).toBe(404);
    expect(fed.props).toHaveLength(1);
  });

  it("feeds the renderer exactly the page's view model of resolvePublicReport", async () => {
    const t = await token();
    await call(t);
    const expected = reportStory((await resolvePublicReport(t))!);
    expect(fed.props[0]!.story).toStrictEqual(expected);
    // And the page renders from that same model: its hero, fixes and cards.
    const html = renderToStaticMarkup(await SharedReportPage({ params: Promise.resolve({ shareId: t }) }));
    for (const f of expected.fixes) expect(html).toContain(f.text);
    for (const r of expected.rows) expect(html).toContain(`data-testid="report-section-${r.s.key}"`);
    expect(html.match(/data-testid="report-section-/g)).toHaveLength(expected.rows.length);
    expect(html).toContain(expected.ctaLine!);
  });

  it("shows the ring grid in the page's order — stored order, not worst first — in both renderers", async () => {
    // Stored order differs from worst-first, so a renderer that re-sorts shows.
    const [ai, perf, gbp] = SECTIONS;
    seedReport([gbp, ai, perf]);
    const t = await token();
    const res = await call(t);
    const html = renderToStaticMarkup(await SharedReportPage({ params: Promise.resolve({ shareId: t }) }));
    const grid = html.slice(html.indexOf('data-testid="ring-grid"'), html.indexOf("</ul>", html.indexOf('data-testid="ring-grid"')));
    const pageRings = [...grid.matchAll(/aria-label="([^":]+): \d+ out of 100"/g)].map((m) => m[1]);
    expect(pageRings).toEqual(["Google Business Profile", "AI search presence", "Website speed"]);
    expect(fed.props[0]!.story.rings.map((r) => LABELS[r.key])).toEqual(pageRings);
    // And the PDF draws them in that order: its grid comes before the cards.
    const text = pdfText(Buffer.from(await res.arrayBuffer()));
    const at = (l: string) => text.indexOf(squash(l));
    expect(at("65Google Business Profile")).toBeLessThan(at("0AI search presence"));
    expect(at("0AI search presence")).toBeLessThan(at("30Website speed"));
  });

  it("never lets a hidden row reach the PDF: model ids, raw metrics, manual-only and not-connected sections", async () => {
    const res = await call(await token());
    const text = pdfText(Buffer.from(await res.arrayBuffer()));
    const input = JSON.stringify(fed.props[0]);
    for (const hidden of ["gemini-2.5-flash", "gpt-4o", "777.7", "888.8", "999", "0.555", "RAW-SENTINEL", "ADS-SENTINEL", "NOT-CONNECTED-SENTINEL", "Cylex"]) {
      expect(input).not.toContain(hidden);
      expect(text).not.toContain(squash(hidden));
    }
  });

  it("fetches the logo through publicFetch and embeds it as a data URI", async () => {
    await call(await token());
    expect(fetched.urls).toEqual(["https://cdn.test/logo.png"]);
    expect(fed.props[0]!.logo).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
  });
});

describe("rate limits", () => {
  it("429s one IP past its budget, with Retry-After, before resolving anything", async () => {
    const t = await token();
    for (let i = 0; i < PDF_IP_LIMIT; i++) expect((await call(t, "203.0.113.7")).status).toBe(200);
    const res = await call(t, "203.0.113.7");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    // An unknown token from the same IP is refused too: guessing costs budget.
    expect((await call("C".repeat(43), "203.0.113.7")).status).toBe(429);
    expect((await call(t, "203.0.113.8")).status).toBe(200);
  });

  it("429s one share past its budget, whatever the IP", async () => {
    const t = await token();
    for (let i = 0; i < PDF_SHARE_LIMIT; i++) expect((await call(t)).status).toBe(200);
    const res = await call(t);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another share is unaffected.
    await revokeReportShare({ reportId: "r1", subAccountId: "sa1" });
    expect((await call(await token())).status).toBe(200);
  }, 60_000);
});

describe("reportPdfFilename", () => {
  it("keeps letters, digits and dashes only, so a business name cannot break the header", async () => {
    const { reportPdfFilename } = await import("@/lib/prospecting/report-pdf");
    expect(reportPdfFilename('Evil"; filename="x.exe\r\nSet-Cookie: a=b')).toBe("report-evil-filename-x-exe-set-cookie-a-b.pdf");
    expect(reportPdfFilename("Café Ñandú / Plumbing")).toBe("report-cafe-nandu-plumbing.pdf");
    expect(reportPdfFilename("中文")).toBe("report.pdf");
    expect(reportPdfFilename(null)).toBe("report.pdf");
    expect(reportPdfFilename("A".repeat(100))).toBe(`report-${"a".repeat(60)}.pdf`);
  });
});
