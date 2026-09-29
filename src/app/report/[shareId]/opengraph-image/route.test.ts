import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The share link's preview image (SOW R4) through the real resolver on the
 * in-memory store: 200 image/png for a live token, 404 exactly when the page
 * 404s, a 5-minute public cache and nothing longer, and the agency logo
 * fetched only through the SSRF-guarded `publicFetch`.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const publicFetch = vi.fn();
vi.mock("@/lib/webhooks/public-fetch", () => ({ publicFetch }));

const { mem } = await import("@/test/gbp-sync-store");
const { mintReportShare, revokeReportShare } = await import("@/lib/prospecting/share");
const { GET } = await import("./route");

// 1×1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const LOGO = "https://cdn.example.test/logo.png";

const get = (shareId: string) => GET(new Request(`http://x/report/${shareId}/opengraph-image`), { params: Promise.resolve({ shareId }) });

beforeEach(() => {
  mem.clear();
  publicFetch.mockReset().mockResolvedValue(new Response(PNG, { status: 200 }));
  mem.seed("prospectReports/r1", {
    agencyId: "ag1", subAccountId: "sa1", createdByUid: "u1", contactId: "c1", status: "ready", shareId: null,
    headline: "No opening hours listed.", generatedAt: new Date("2026-09-20T00:00:00Z"),
    sections: [
      { key: "gbp", status: "ok", score: 65, findings: [{ code: "gbp_no_hours", text: "No opening hours listed." }], raw: {} },
      { key: "lead_capture", status: "ok", score: 100, findings: [], raw: {} },
    ],
  });
  mem.seed("agencies/ag1", { name: "Example Agency", logoUrl: LOGO, brandColor: "#0F766E" });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", prospectingEnabledByAgency: true });
  mem.seed("contacts/c1", { subAccountId: "sa1", company: "Example Plumbing Co" });
});

afterEach(() => vi.restoreAllMocks());

async function token(): Promise<string> {
  const minted = await mintReportShare({ reportId: "r1", subAccountId: "sa1", uid: "u1" });
  if (typeof minted === "string") throw new Error(minted);
  return minted.token;
}

describe("GET /report/[token]/opengraph-image", () => {
  it("renders a PNG for a live token, cacheable for 5 minutes and no longer", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await get(await token());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 8).equals(PNG.subarray(0, 8))).toBe(true);
    // The logo came through the SSRF guard, and nothing was fetched any other way.
    expect(publicFetch).toHaveBeenCalledTimes(1);
    expect(publicFetch.mock.calls[0]![0]).toBe(LOGO);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders without a logo when the agency has none or it fails to load", async () => {
    publicFetch.mockRejectedValueOnce(new Error("refused"));
    const failed = await get(await token());
    expect(failed.status).toBe(200);
    expect(Buffer.from(await failed.arrayBuffer()).length).toBeGreaterThan(0);
    mem.seed("agencies/ag1", { name: "Example Agency" });
    publicFetch.mockClear();
    const none = await get(await token());
    expect(none.status).toBe(200);
    await none.arrayBuffer();
    expect(publicFetch).not.toHaveBeenCalled();
  });

  it("404s for a revoked token and an unknown one, exactly as the page does", async () => {
    const t = await token();
    await revokeReportShare({ reportId: "r1", subAccountId: "sa1" });
    for (const id of [t, "B".repeat(43), "not-a-token"]) {
      const res = await get(id);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).not.toBe("image/png");
    }
    expect(publicFetch).not.toHaveBeenCalled();
  });

  it("404s when the Prospecting gate is off, a refusal only the shared resolver knows", async () => {
    const t = await token();
    mem.seed("subAccounts/sa1", { agencyId: "ag1", prospectingEnabledByAgency: false });
    expect((await get(t)).status).toBe(404);
  });

  it("renders with no business name and no headline", async () => {
    mem.seed("contacts/c1", { subAccountId: "sa1", name: "Jane Person", source: "manual" });
    await mem.db.doc("prospectReports/r1").update({ headline: null });
    const res = await get(await token());
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).subarray(1, 4).toString()).toBe("PNG");
  });
});
