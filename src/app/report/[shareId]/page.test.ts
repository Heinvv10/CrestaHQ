import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The public report page (/report/[token]), rendered to HTML through the real
 * resolver on the in-memory store: a live share renders, a dead one 404s.
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

beforeEach(() => {
  mem.clear();
  mem.seed("prospectReports/r1", {
    agencyId: "ag1", subAccountId: "sa1", createdByUid: "u1", contactId: "c1", status: "ready", shareId: null,
    headline: "No opening hours on Google", generatedAt: new Date("2026-09-20T00:00:00Z"), usageMonth: "2026-09",
    sections: [
      { key: "gbp", status: "ok", score: 60, findings: [{ code: "gbp_no_hours", text: "No opening hours listed." }], raw: { s: "RAW-SENTINEL" } },
      { key: "lead_capture", status: "ok", score: 20, findings: [], raw: { whatsapp: false, booking: true, s: "RAW-SENTINEL" } },
      { key: "ads", status: "timeout", score: null, findings: [], reason: "The ad library did not answer in time.", raw: {} },
    ],
  });
  mem.seed("agencies/ag1", { name: "Cresta Agency", logoUrl: "https://cdn.test/logo.png" });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", prospectingEnabledByAgency: true });
  mem.seed("contacts/c1", { subAccountId: "sa1", company: "Acme Plumbing" });
  mem.seed("subAccounts/sa1/bookingPages/intro", { status: "published", createdAt: new Date("2026-09-01T00:00:00Z") });
});

async function token(): Promise<string> {
  const minted = await mintReportShare({ reportId: "r1", subAccountId: "sa1", uid: "u1" });
  if (typeof minted === "string") throw new Error(minted);
  return minted.token;
}

describe("/report/[token]", () => {
  it("renders the branded report, the honest timeout, and the booking CTA", async () => {
    const html = await render(await token());
    for (const text of ["Cresta Agency", "Acme Plumbing", "No opening hours on Google", "60/100", "No opening hours listed.", "Timed out", "The ad library did not answer in time.", 'href="/b/sa1/intro"', "WhatsApp click-to-chat", "Online booking"]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain("RAW-SENTINEL");
  });

  it("404s for a revoked or unknown token", async () => {
    const t = await token();
    await revokeReportShare({ reportId: "r1", subAccountId: "sa1" });
    await expect(render(t)).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(render("B".repeat(43))).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
