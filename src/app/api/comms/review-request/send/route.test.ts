import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/comms/review-request/send — the manual "Request review". Seam:
 * the route → real contact access check → real dispatcher → in-memory
 * Firestore; only the Twilio send and the inbox upsert are doubles. Proves
 * the SIGNED-IN sender reaches the reviewRequests log (SP5 a).
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/comms/twilio", () => ({
  sendSmsForSubAccount: vi.fn(async () => ({ sid: "SMroute1", from: "+15550001", mode: "dedicated" })),
  sendWhatsappForSubAccount: vi.fn(),
  sendWhatsappTemplateForSubAccount: vi.fn(),
  smsIsConfigured: () => true,
  subAccountTwilioIsConfigured: () => true,
  subAccountWhatsappIsConfigured: () => true,
}));
vi.mock("@/lib/server/conversations-service", () => ({ upsertConversationForMessage: vi.fn(async () => undefined) }));

import { AGENCY, LOC_A, LOC_NORTH, OTHER_SA, SA, asUser, mem, resetSync, seedExtraListing } from "@/test/gbp-sync-harness";
import { sendSmsForSubAccount } from "@/lib/comms/twilio";
import { POST } from "./route";

const CONTACT = "c_route";
const B_URL = "https://g.page/r/fixture-north/review";

function post(uid: string, contactId = CONTACT, extra: Record<string, unknown> = {}) {
  return POST(
    asUser("http://127.0.0.1:3100/api/comms/review-request/send", uid, "POST", JSON.stringify({ contactId, ...extra })),
  );
}
const smsBodies = () => vi.mocked(sendSmsForSubAccount).mock.calls.map(([a]) => (a as { body: string }).body);
const logRows = (sa = SA) => mem.list(`subAccounts/${sa}/reviewRequests`);

beforeEach(() => {
  resetSync();
  vi.mocked(sendSmsForSubAccount).mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const sub = mem.read(`subAccounts/${SA}`)!;
  mem.seed(`subAccounts/${SA}`, {
    ...sub,
    name: "Fixture Co",
    googleReviewConfig: {
      enabled: false, reviewUrl: "https://g.page/r/fixture/review", channel: "sms", messageTemplate: "",
      whatsappTemplateId: null, cooldownDays: 90, triggerOnQuotePaid: false, triggerOnDealCompleted: false,
    },
  });
  mem.seed(`contacts/${CONTACT}`, {
    name: "Fixture Person", phone: "+15005550006", agencyId: AGENCY, subAccountId: SA, createdByUid: "uid_admin",
  });
});

describe("manual send → reviewRequests log", () => {
  it("logs the send under the contact's sub-account with the signed-in sender", async () => {
    const res = await post("uid_collab");
    expect(await res.json()).toEqual({ ok: true, sent: true });
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agencyId: AGENCY, subAccountId: SA, createdByUid: "uid_collab", contactId: CONTACT,
      channel: "sms", trigger: "manual", status: "sent", messageSid: "SMroute1", clickedAt: null, feedbackAt: null,
    });
    expect(rows[0].sentAt).toBeInstanceOf(Date);
    expect(logRows(OTHER_SA)).toEqual([]);
  });

  it("a caller who cannot reach the contact sends nothing and logs nothing", async () => {
    const res = await post("uid_other_admin");
    expect(res.status).toBe(403);
    expect(logRows()).toEqual([]);
  });
});

describe("locationName — which listing the request is for (MULTI_LISTING_V1_PLAN.md PR 5)", () => {
  beforeEach(() => {
    seedExtraListing(SA);
    const sub = mem.read(`subAccounts/${SA}`)!;
    const cfg = sub.googleReviewConfig as Record<string, unknown>;
    mem.seed(`subAccounts/${SA}`, { ...sub, googleReviewConfig: { ...cfg, listingUrls: { "e2e-velo-gqeberha-north": B_URL } } });
  });

  it("an extra listing's request carries that listing's link and is logged against it", async () => {
    const res = await post("uid_collab", CONTACT, { locationName: LOC_NORTH });
    expect(await res.json()).toEqual({ ok: true, sent: true });
    expect(smsBodies()).toHaveLength(1);
    expect(smsBodies()[0]).toContain(B_URL);
    expect(smsBodies()[0]).not.toContain("https://g.page/r/fixture/review");
    expect(logRows()[0]).toMatchObject({ locationName: LOC_NORTH, contactId: CONTACT });
  });

  it("the main listing named explicitly sends the main link, with no locationName on the row", async () => {
    expect(await (await post("uid_collab", CONTACT, { locationName: LOC_A })).json()).toEqual({ ok: true, sent: true });
    expect(smsBodies()[0]).toContain("https://g.page/r/fixture/review");
    expect(logRows()[0]).not.toHaveProperty("locationName");
  });

  it.each<[string, unknown]>([
    ["a location this sub-account does not manage", "locations/not-ours"],
    ["an empty string", ""],
    ["a number", 7],
    ["an object", { locationName: LOC_NORTH }],
  ])("400 invalid_listing for %s — nothing sent, nothing logged", async (_l, locationName) => {
    const res = await post("uid_collab", CONTACT, { locationName });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_listing" });
    expect(smsBodies()).toEqual([]);
    expect(logRows()).toEqual([]);
  });

  it("another sub-account's extra listing is not one of this contact's", async () => {
    seedExtraListing(OTHER_SA, "locations/e2e-other-extra");
    const res = await post("uid_collab", CONTACT, { locationName: "locations/e2e-other-extra" });
    expect(res.status).toBe(400);
    expect(smsBodies()).toEqual([]);
  });
});
