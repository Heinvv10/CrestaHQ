import { beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * SP5 d1 — a message scheduled from the Conversations composer is an inbox
 * send whose person is not at the keyboard when it fires: carrying the review
 * link, it is logged when it fires (source inbox, the person who booked it).
 * The real worker and send service over an in-memory Firestore; only Twilio,
 * the inbox upsert and usage bookkeeping are doubles.
 */

const mem = createMemoryFirestore();
const sms = vi.fn();
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({
    getUser: async (uid: string) => ({ uid, email: "op@example.com", customClaims: { status: "active", agencyRole: "owner", agencyId: "ag1" } }),
  }),
}));
vi.mock("@/lib/comms/twilio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/comms/twilio")>()),
  sendSmsForSubAccount: (...a: unknown[]) => sms(...a),
}));
vi.mock("@/lib/server/conversations-service", () => ({ upsertConversationForMessage: async () => undefined }));
vi.mock("@/lib/comms/usage", () => ({ recordSend: async () => {} }));

const { fireScheduledMessage } = await import("@/lib/server/scheduled-messages/fire");

const REVIEW_URL = "https://g.page/r/ann/review";
const rows = () => mem.list("subAccounts/sa1/reviewRequests");

function seedScheduled(id: string, body: string) {
  mem.seed(`contacts/c1/scheduledMessages/${id}`, {
    agencyId: "ag1", subAccountId: "sa1", createdByUid: "u1", contactId: "c1", channel: "sms", body,
    subject: null, inReplyTo: null, references: null, sendAt: Timestamp.fromMillis(Date.now()), status: "pending",
    failureReason: null, failureCode: null, qstashMessageId: "msg_1", sentMessageId: null,
  });
}

beforeEach(() => {
  mem.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  sms.mockReset().mockResolvedValue({ sid: "SM1", mode: "dedicated", from: "+15550001" });
  mem.seed("subAccounts/sa1", {
    agencyId: "ag1",
    twilioConfig: { enabled: true, accountSid: "AC1", authToken: "tok", fromNumber: "+15550001" },
    googleReviewConfig: { reviewUrl: REVIEW_URL },
  });
  mem.seed("contacts/c1", { agencyId: "ag1", subAccountId: "sa1", name: "Ann", phone: "+27820000001" });
});

describe("scheduled inbox message", () => {
  it("carrying the review link: one inbox row by the person who scheduled it", async () => {
    seedScheduled("s1", `Thanks Ann! ${REVIEW_URL}`);
    expect(await fireScheduledMessage("c1", "s1")).toEqual({ outcome: "sent", messageId: "SM1" });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ source: "inbox", channel: "sms", createdByUid: "u1", status: "sent", messageSid: "SM1" });
  });

  it("without it: nothing", async () => {
    seedScheduled("s1", "See you at 3");
    await fireScheduledMessage("c1", "s1");
    expect(sms).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([]);
  });

  it("a redelivery of a sent message logs nothing more", async () => {
    seedScheduled("s1", `Thanks Ann! ${REVIEW_URL}`);
    await fireScheduledMessage("c1", "s1");
    await fireScheduledMessage("c1", "s1");
    expect(rows()).toHaveLength(1);
  });

  it("a provider failure of a review ask is logged failed", async () => {
    sms.mockRejectedValueOnce(new Error("timeout"));
    seedScheduled("s1", `Thanks Ann! ${REVIEW_URL}`);
    await fireScheduledMessage("c1", "s1");
    expect(rows()).toMatchObject([{ status: "failed", failureKind: "send_failed" }]);
  });
});
