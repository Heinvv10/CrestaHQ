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

import { AGENCY, OTHER_SA, SA, asUser, mem, resetSync } from "@/test/gbp-sync-harness";
import { POST } from "./route";

const CONTACT = "c_route";

function post(uid: string, contactId = CONTACT) {
  return POST(
    asUser("http://127.0.0.1:3100/api/comms/review-request/send", uid, "POST", JSON.stringify({ contactId })),
  );
}
const logRows = (sa = SA) => mem.list(`subAccounts/${sa}/reviewRequests`);

beforeEach(() => {
  resetSync();
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
