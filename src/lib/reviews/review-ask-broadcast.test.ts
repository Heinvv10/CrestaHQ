import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * SP5 d1 — a broadcast email that carries the sub-account's review link is a
 * review ask, logged once PER RECIPIENT by the per-recipient worker (source
 * broadcast). The real step route over an in-memory Firestore; QStash's
 * signature check and the email provider are doubles.
 */

const mem = createMemoryFirestore();
const sendEmail = vi.fn();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/automations/qstash", () => ({ qstashIsConfigured: () => true, verifyQStashSignature: async () => true }));
vi.mock("@/lib/comms/resend", () => ({
  emailIsConfigured: () => true,
  tenantFrom: () => "sender@tenant.test",
  sendEmail: (...a: unknown[]) => sendEmail(...a),
}));
vi.mock("@/lib/server/usage-meter", () => ({ checkQuota: async () => ({ allowed: true }) }));
vi.mock("@/lib/automations/unsubscribe-token", () => ({ buildUnsubscribeUrl: (id: string) => `https://app.test/u/${id}` }));
/** The recipient's send-row status (its idempotency marker) when each log row was written. */
const statusAtLog: unknown[] = [];
vi.mock("@/lib/reviews/request-log", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/reviews/request-log")>();
  return {
    ...real,
    logReviewRequest: async (input: Parameters<typeof real.logReviewRequest>[0]) => {
      statusAtLog.push(mem.read(`broadcasts/b1/sends/${input.contactId}`)?.status);
      return real.logReviewRequest(input);
    },
  };
});

import { markProviderAttempted } from "@/lib/comms/provider-attempt";
const { POST } = await import("@/app/api/broadcasts/email/step/route");

const REVIEW_URL = "https://g.page/r/blitz/review";
const rows = () => mem.list("subAccounts/sa1/reviewRequests");

function step(contactId: string) {
  return POST(
    new Request("https://app.test/api/broadcasts/email/step", {
      method: "POST",
      headers: { "upstash-signature": "sig" },
      body: JSON.stringify({ broadcastId: "b1", contactId }),
    }),
  );
}

function seedBroadcast(body: string) {
  mem.seed("message_templates/t1", { subject: "Thanks {{contact.firstName}}", body });
  mem.seed("broadcasts/b1", {
    subAccountId: "sa1", agencyId: "ag1", templateId: "t1", templateName: "Thanks", status: "sending",
    totals: { queued: 2, sent: 0, failed: 0, skipped: 0 },
  });
  for (const c of ["c1", "c2"]) mem.seed(`broadcasts/b1/sends/${c}`, { status: "queued", attempts: 0 });
}

beforeEach(() => {
  mem.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  sendEmail.mockReset().mockResolvedValue({ id: "<m1@tenant.test>" });
  mem.seed("subAccounts/sa1", { name: "Blitz", agencyId: "ag1", broadcastsEnabledByAgency: true, googleReviewConfig: { reviewUrl: REVIEW_URL } });
  mem.seed("agencies/ag1", {});
  for (const [id, name] of [["c1", "Thandi"], ["c2", "Sipho"]]) {
    mem.seed(`contacts/${id}`, { agencyId: "ag1", subAccountId: "sa1", name, email: `${id}@example.test` });
  }
});

describe("broadcast email", () => {
  it("a throw before the provider was reached is no row", async () => {
    sendEmail.mockRejectedValueOnce(new Error("EMAIL_FROM is not set."));
    seedBroadcast(`Review us: ${REVIEW_URL}`);
    await step("c1");
    expect(rows()).toEqual([]);
  });

  it("carrying the review link: one row per recipient, source broadcast", async () => {
    seedBroadcast(`Loved the install? Review us: ${REVIEW_URL}\n{{unsubscribeLink}}`);
    await step("c1");
    await step("c2");
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(rows().map((r) => r.contactId).sort()).toEqual(["c1", "c2"]);
    expect(rows()[0]).toMatchObject({
      agencyId: "ag1", subAccountId: "sa1", createdByUid: "broadcast", channel: "email", source: "broadcast",
      trigger: null, status: "sent", messageSid: "<m1@tenant.test>",
    });
  });

  it("the log row is written only after the recipient is marked settled", async () => {
    statusAtLog.length = 0;
    seedBroadcast(`Review us: ${REVIEW_URL}`);
    await step("c1");
    sendEmail.mockRejectedValueOnce(markProviderAttempted(new Error("550")));
    await step("c2");
    expect(statusAtLog).toEqual(["sent", "failed"]);
  });

  it("a QStash redelivery of a settled recipient logs nothing more", async () => {
    seedBroadcast(`Review us: ${REVIEW_URL}`);
    await step("c1");
    await step("c1");
    expect(rows()).toHaveLength(1);
  });

  it("without the link: nothing", async () => {
    seedBroadcast("Our September newsletter.\n{{unsubscribeLink}}");
    await step("c1");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([]);
  });

  it("a failed send of a review ask is logged failed", async () => {
    sendEmail.mockRejectedValueOnce(markProviderAttempted(new Error("mailbox c1@example.test unavailable")));
    seedBroadcast(`Review us: ${REVIEW_URL}`);
    await step("c1");
    expect(rows()).toMatchObject([{ status: "failed", failureKind: "send_failed", messageSid: null }]);
  });
});
