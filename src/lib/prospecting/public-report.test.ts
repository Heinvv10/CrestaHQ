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

  it("normalises Meta's formatted Cloud display number to E.164, and drops one that does not parse", async () => {
    seed({}, { whatsappCloudMeta: { displayPhoneNumber: "+27 68 760 0000" } });
    expect((await resolvePublicReport(TOKEN))?.whatsappNumber).toBe("+27687600000");
    seed({}, { whatsappCloudMeta: { displayPhoneNumber: "call us!" } });
    expect((await resolvePublicReport(TOKEN))?.whatsappNumber).toBeNull();
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

describe("raw speed metrics", () => {
  it("are stripped from the public sections; the plain LCP fact stays", async () => {
    seed();
    await mem.db.doc("prospectReports/r1").update({
      sections: [
        {
          key: "website_performance", status: "ok", score: 30,
          findings: [{ code: "slow_mobile", text: "Slow." }],
          raw: { lcpSeconds: 6.2, fcpSeconds: 2.1, speedIndexSeconds: 7.4, tbtMs: 900, cls: 0.2, mobileViewport: true },
        },
      ],
    });
    const report = await resolvePublicReport(TOKEN);
    expect(report?.sections[0]?.details).toEqual({ lcpSeconds: 6.2, mobileViewport: true });
  });
});

describe("mystery shop (sections 11 and 12)", () => {
  const TARGET_EMAIL = "owner@acme-plumbing.co.za";
  const TARGET_PHONE = "+27829876543";
  const shop = (id: string, extra: Record<string, unknown>) =>
    mem.seed(`mysteryShops/${id}`, {
      agencyId: "ag1", subAccountId: "sa1", contactId: "c1", channel: "email", target: TARGET_EMAIL,
      targetLabel: TARGET_EMAIL, status: "responded", sentAt: new Date("2026-10-08T08:00:00Z"),
      respondedAt: new Date("2026-10-08T10:14:00Z"), responseMs: (2 * 60 + 14) * 60_000, autoReplyAt: null,
      jobValueCents: 150_000, currency: "ZAR", enquiryText: "Do you do plumber in Gqeberha?",
      providerRef: "<ref-123@crestahq.com>", failure: null, createdAt: new Date("2026-10-08T08:00:00Z"),
      ...extra,
    });

  it("shows settled outcomes and never a target, provider ref, enquiry or failure", async () => {
    seed();
    shop("e1", {});
    shop("k1", {
      channel: "call", target: TARGET_PHONE, targetLabel: TARGET_PHONE, status: "missed", respondedAt: null,
      responseMs: null, providerRef: "call-987", missedConfirmedAt: new Date("2026-10-09T10:00:00Z"), missedConfirmedByUid: "UID-SECRET",
    });
    shop("k0", { channel: "call", target: TARGET_PHONE, status: "failed", sentAt: null, failure: { code: "x", reason: "SECRET" } });
    shop("other", { contactId: "c9", target: "other@else.example" });
    const report = await resolvePublicReport(TOKEN);
    expect(report?.mysteryShop).toEqual([
      {
        key: "speed_to_lead",
        title: "Speed to lead",
        items: [
          expect.objectContaining({ channel: "email", outcome: "responded", text: "Responded in 2 h 14 m by email." }),
          expect.objectContaining({ channel: "call", outcome: "missed", text: "No response within 24 h — an estimated R1,500 lead missed." }),
        ],
      },
    ]);
    const json = JSON.stringify(report);
    expect(json).not.toContain(TARGET_EMAIL);
    expect(json).not.toContain("acme-plumbing");
    expect(json).not.toContain("829876543");
    expect(json).not.toContain("27829876543");
    expect(json).not.toContain("ref-123");
    expect(json).not.toContain("call-987");
    expect(json).not.toContain("Gqeberha");
    expect(json).not.toContain("SECRET");
    expect(json).not.toContain("other@else.example");
    expect(json).not.toContain("UID-SECRET");
  });

  it("an unconfirmed miss is absent from the public report and its JSON; confirming it makes it public", async () => {
    seed();
    shop("k1", { channel: "call", target: TARGET_PHONE, status: "missed", respondedAt: null, responseMs: null });
    expect((await resolvePublicReport(TOKEN))?.mysteryShop).toEqual([]);
    expect(JSON.stringify(await resolvePublicReport(TOKEN))).not.toContain("lead missed");
    shop("k1", { channel: "call", target: TARGET_PHONE, status: "missed", respondedAt: null, responseMs: null, missedConfirmedAt: new Date() });
    expect((await resolvePublicReport(TOKEN))?.mysteryShop[0].items[0].outcome).toBe("missed");
  });

  it("WhatsApp (section 12): the outcome, never the number, the message id or the delivery stamps", async () => {
    seed();
    shop("w1", {
      channel: "whatsapp", target: TARGET_PHONE, targetLabel: TARGET_PHONE, responseMs: 14 * 60_000, providerRef: "wamid.SECRET",
      responseVia: "whatsapp", senderAuth: "pass", deliveredAt: new Date("2026-10-08T08:00:02Z"), readAt: new Date("2026-10-08T08:01:00Z"),
      enquiryText: "Hi, do you offer plumber in Gqeberha?",
    });
    const report = await resolvePublicReport(TOKEN);
    expect(report?.mysteryShop).toEqual([
      { key: "whatsapp_response", title: "WhatsApp responsiveness", items: [expect.objectContaining({ text: "Responded in 14 m on WhatsApp." })] },
    ]);
    const json = JSON.stringify(report?.mysteryShop);
    for (const leak of ["829876543", "wamid", "SECRET", "deliveredAt", "readAt", "Gqeberha", "pass"]) expect(json).not.toContain(leak);
    for (const leak of ["829876543", "wamid", "deliveredAt"]) expect(JSON.stringify(report)).not.toContain(leak);
  });

  it("no settled shop → no section", async () => {
    seed();
    shop("e1", { status: "sent", respondedAt: null, responseMs: null });
    expect((await resolvePublicReport(TOKEN))?.mysteryShop).toEqual([]);
  });
});
