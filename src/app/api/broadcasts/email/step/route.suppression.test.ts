import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Broadcast step against the sub-account's suppression list: real route →
 * real sendEmail → real lookup, over an in-memory Firestore. A suppressed
 * recipient's row settles as `skipped` / `suppressed` (shown on the broadcast
 * page), counted under totals.skipped — not as a send, and not as a failure.
 */

const s = () => import("@/test/email-suppression-seam");
vi.mock("@/lib/firebase/admin", async () => (await s()).seamMocks.admin());
vi.mock("@/lib/comms/smtp", async () => (await s()).seamMocks.smtp());
vi.mock("@/lib/server/email-conversations", async () => (await s()).seamMocks.conversations());
vi.mock("@/lib/server/usage-meter", async (orig) => (await s()).seamMocks.usage(orig));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  verifyQStashSignature: async () => true,
}));
vi.mock("@/lib/automations/unsubscribe-token", () => ({
  buildUnsubscribeUrl: (id: string) => `https://app.test/u/${id}`,
}));
vi.mock("@/lib/reviews/review-ask", () => ({ logIfReviewAsk: async () => undefined }));

const { SA, AGENCY, mem, resetSeam, suppress, wireRecipients } = await s();
const { POST } = await import("./route");

const step = () =>
  POST(
    new Request("https://app.test/api/broadcasts/email/step", {
      method: "POST",
      headers: { "upstash-signature": "sig" },
      body: JSON.stringify({ broadcastId: "b1", contactId: "c1" }),
    })
  );

beforeEach(() => {
  resetSeam();
  mem.seed(`agencies/${AGENCY}`, {});
  mem.seed("message_templates/t1", { subject: "News", body: "Hello\n{{unsubscribeLink}}" });
  mem.seed("contacts/c1", {
    name: "Thandi",
    email: "thandi@example.co.za",
    emailOptedOut: false,
    agencyId: AGENCY,
    subAccountId: SA,
  });
  mem.seed("broadcasts/b1", {
    agencyId: AGENCY,
    subAccountId: SA,
    templateId: "t1",
    templateName: "News",
    status: "sending",
    totals: { queued: 1, sent: 0, skipped: 0, failed: 0 },
  });
  mem.seed("broadcasts/b1/sends/c1", { status: "queued", skippedReason: null });
});

describe("broadcast email step", () => {
  it("sends to an address that is not suppressed", async () => {
    await step();
    expect(wireRecipients()).toEqual(["thandi@example.co.za"]);
    expect(mem.read("broadcasts/b1/sends/c1")).toMatchObject({ status: "sent" });
  });

  it("settles a suppressed recipient as skipped: suppressed, sending nothing", async () => {
    suppress("thandi@example.co.za");
    const res = await step();
    expect(await res.json()).toMatchObject({ status: "skipped" });
    expect(wireRecipients()).toEqual([]);
    expect(mem.read("broadcasts/b1/sends/c1")).toMatchObject({
      status: "skipped",
      skippedReason: "suppressed",
    });
    expect(mem.read("broadcasts/b1")).toMatchObject({
      status: "completed",
      totals: { queued: 0, skipped: 1, sent: 0, failed: 0 },
    });
  });
});
