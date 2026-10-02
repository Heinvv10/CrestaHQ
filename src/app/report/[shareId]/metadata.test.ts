import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The report page's link-preview metadata (SOW R4): og:title is the
 * resolver's business name (never a person's), og:image resolves against
 * NEXT_PUBLIC_APP_URL, and a refused token gets nothing about the report.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

const { mem } = await import("@/test/gbp-sync-store");
const { mintReportShare, revokeReportShare } = await import("@/lib/prospecting/share");
const { generateMetadata } = await import("./page");

const meta = (shareId: string) => generateMetadata({ params: Promise.resolve({ shareId }) });
const APP_URL = "https://crm.example.test";
const SECTIONS = [{ key: "gbp", status: "ok", score: 65, findings: [{ code: "gbp_no_hours", text: "No opening hours listed." }], raw: {} }];
const prior = process.env.NEXT_PUBLIC_APP_URL;

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  mem.clear();
  mem.seed("prospectReports/r1", {
    agencyId: "ag1", subAccountId: "sa1", createdByUid: "u1", contactId: "c1", status: "ready", shareId: null,
    headline: "No opening hours listed.", generatedAt: new Date("2026-09-20T00:00:00Z"), sections: SECTIONS,
  });
  mem.seed("agencies/ag1", { name: "Example Agency" });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", prospectingEnabledByAgency: true });
  mem.seed("contacts/c1", { subAccountId: "sa1", company: "Example Plumbing Co" });
});

afterEach(() => {
  if (prior === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = prior;
});

async function token(): Promise<string> {
  const minted = await mintReportShare({ reportId: "r1", subAccountId: "sa1", uid: "u1" });
  if (typeof minted === "string") throw new Error(minted);
  return minted.token;
}

const ogImages = (m: Awaited<ReturnType<typeof meta>>) =>
  (m.openGraph?.images ?? []) as Array<{ url: string; width: number; height: number }>;

describe("generateMetadata", () => {
  it("titles the preview with the business and points og:image at the app URL", async () => {
    const t = await token();
    const m = await meta(t);
    expect(m.openGraph?.title).toBe("Example Plumbing Co");
    expect(m.description).toBe("No opening hours listed.");
    expect(m.openGraph?.description).toBe("No opening hours listed.");
    expect(m.metadataBase?.origin).toBe(new URL(APP_URL).origin);
    expect(ogImages(m)).toEqual([{ url: `/report/${t}/opengraph-image`, width: 1200, height: 630 }]);
    expect(m.robots).toEqual({ index: false, follow: false });
    expect(m.referrer).toBe("no-referrer");
  });

  it("uses the generic title when the resolver withholds the name (a person, not a business)", async () => {
    mem.seed("contacts/c1", { subAccountId: "sa1", name: "Jane Person", source: "manual" });
    const m = await meta(await token());
    expect(m.openGraph?.title).toBe("Online presence report");
    expect(JSON.stringify(m)).not.toContain("Jane");
  });

  const reseed = (headline: string | null, sections: unknown[]) =>
    mem.seed("prospectReports/r1", {
      agencyId: "ag1", subAccountId: "sa1", createdByUid: "u1", contactId: "c1", status: "ready", shareId: null,
      headline, generatedAt: new Date("2026-09-20T00:00:00Z"), sections,
    });

  it("says what the hero says: the top finding when no headline is stored", async () => {
    reseed(null, SECTIONS);
    const m = await meta(await token());
    expect(m.description).toBe("No opening hours listed.");
    expect(m.openGraph?.description).toBe(m.description);
  });

  it("says 'No major issues found' when no public finding exists, even with a stored headline", async () => {
    reseed("No Google Ads running.", [{ key: "gbp", status: "ok", score: 100, findings: [], raw: {} }]);
    const m = await meta(await token());
    expect(m.description).toBe("No major issues found");
    expect(JSON.stringify(m)).not.toContain("Google Ads");
  });

  it("gives a revoked or unknown token nothing about the report, without throwing", async () => {
    const t = await token();
    await revokeReportShare({ reportId: "r1", subAccountId: "sa1" });
    for (const id of [t, "B".repeat(43), "not-a-token"]) {
      const m = await meta(id);
      expect(m.openGraph).toBeUndefined();
      expect(m.metadataBase).toBeUndefined();
      expect(JSON.stringify(m)).not.toContain("Example");
    }
  });

  it("drops the image rather than resolving it against localhost when the app URL is unset or malformed", async () => {
    const t = await token();
    for (const v of [undefined, "not a url"]) {
      if (v === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = v;
      const m = await meta(t);
      expect(m.openGraph?.title).toBe("Example Plumbing Co");
      expect(m.description).toBe("No opening hours listed.");
      expect(m.openGraph?.description).toBe("No opening hours listed.");
      expect(m.openGraph?.images).toBeUndefined();
      expect(m.metadataBase).toBeUndefined();
    }
  });
});
