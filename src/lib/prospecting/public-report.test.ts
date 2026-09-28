import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `resolvePublicReport`'s R2 additions: the resolved/validated `brandColor`
 * and the WhatsApp CTA number precedence (explicit field, then a connected
 * WhatsApp Cloud sender, never a bridge sender). Direct Firestore seeding on
 * the in-memory store — no worker, no share minting.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

const { mem } = await import("@/test/gbp-sync-store");
const { hashShareToken } = await import("@/lib/snapshots/share");
const { resolvePublicReport } = await import("@/lib/prospecting/public-report");

const TOKEN = "T".repeat(43);
const SHARE_ID = hashShareToken(TOKEN);

function seed(agencyOver: Record<string, unknown> = {}, subOver: Record<string, unknown> = {}) {
  mem.clear();
  mem.seed(`agencies/ag1`, { name: "Cresta Agency", ownerUid: "owner1", ...agencyOver });
  mem.seed(`subAccounts/sa1`, { name: "Cresta", agencyId: "ag1", prospectingEnabledByAgency: true, ...subOver });
  mem.seed(`contacts/c1`, { subAccountId: "sa1", agencyId: "ag1", company: "Acme Plumbing", source: "prospecting" });
  mem.seed(`prospectReports/r1`, {
    agencyId: "ag1", subAccountId: "sa1", contactId: "c1", status: "ready",
    shareId: SHARE_ID, sections: [], headline: "No issues found", generatedAt: null,
  });
  mem.seed(`prospectReportShares/${SHARE_ID}`, { agencyId: "ag1", subAccountId: "sa1", reportId: "r1", revokedAt: null });
}

describe("brandColor read-time fallback", () => {
  it("returns the stored value when it clears WCAG AA contrast", async () => {
    seed({ brandColor: "#2563EB" });
    const report = await resolvePublicReport(TOKEN);
    expect(report?.agency.brandColor).toBe("#2563EB");
  });

  it("falls back to the default for a malformed stored value", async () => {
    seed({ brandColor: "not-a-color" });
    const report = await resolvePublicReport(TOKEN);
    expect(report?.agency.brandColor).toBe("#2563EB");
  });

  it("falls back to the default for a stored value that fails contrast", async () => {
    // Written before this file's validation shipped, or by a path that skipped the PATCH route.
    seed({ brandColor: "#FFFF00" });
    const report = await resolvePublicReport(TOKEN);
    expect(report?.agency.brandColor).toBe("#2563EB");
  });

  it("falls back to the default when unset", async () => {
    seed();
    const report = await resolvePublicReport(TOKEN);
    expect(report?.agency.brandColor).toBe("#2563EB");
  });
});

describe("whatsappNumber precedence", () => {
  it("prefers the explicit sub-account field", async () => {
    seed({}, {
      whatsappNumber: "+27821234567",
      whatsappCloudMeta: { displayPhoneNumber: "+27110000000" },
    });
    const report = await resolvePublicReport(TOKEN);
    expect(report?.whatsappNumber).toBe("+27821234567");
  });

  it("falls back to a connected WhatsApp Cloud sender when unset", async () => {
    seed({}, { whatsappCloudMeta: { displayPhoneNumber: "+27110000000" } });
    const report = await resolvePublicReport(TOKEN);
    expect(report?.whatsappNumber).toBe("+27110000000");
  });

  it("never falls back to a bridge sender's number", async () => {
    seed({}, { whatsappBridgeMeta: { displayPhoneNumber: "+27820000001" } });
    const report = await resolvePublicReport(TOKEN);
    expect(report?.whatsappNumber).toBeNull();
  });

  it("is null when neither the field nor a Cloud sender is set", async () => {
    seed();
    const report = await resolvePublicReport(TOKEN);
    expect(report?.whatsappNumber).toBeNull();
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});
