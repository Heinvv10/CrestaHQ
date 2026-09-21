import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Inbox email reply against the sub-account's suppression list: real route →
 * real conversation send service → real sendEmail → real lookup. A human
 * sent this, so the refusal comes back as a 422 whose error names the address
 * and the reason — the composer shows it.
 */

const s = () => import("@/test/email-suppression-seam");
vi.mock("@/lib/firebase/admin", async () => (await s()).seamMocks.admin());
vi.mock("@/lib/comms/smtp", async (orig) => (await s()).seamMocks.smtp(orig));
vi.mock("@/lib/server/email-conversations", async () => (await s()).seamMocks.conversations());
vi.mock("@/lib/server/usage-meter", async (orig) => (await s()).seamMocks.usage(orig));
vi.mock("@/lib/comms/usage", () => ({ recordSend: async () => undefined }));
vi.mock("@/lib/reviews/review-ask", () => ({
  askOutcomeOf: () => null,
  logInboxReviewAsk: async () => undefined,
}));
vi.mock("@/lib/comms/route-auth", async () => ({
  requireUid: () => ({ uid: "u1", email: "operator@example.com" }),
  requireContactAccessible: async () => ({
    id: "c1",
    subAccountId: (await s()).SA,
    agencyId: "ag1",
    email: "thandi@example.co.za",
  }),
}));

const { resetSeam, suppress, wireRecipients } = await s();
const { POST } = await import("./route");

const reply = () =>
  POST(
    new Request("https://app.test/api/comms/email/send", {
      method: "POST",
      body: JSON.stringify({ contactId: "c1", subject: "Re: install", body: "Hi" }),
    })
  );

beforeEach(resetSeam);

describe("inbox email reply", () => {
  it("sends to an address that is not suppressed", async () => {
    expect((await reply()).status).toBe(200);
    expect(wireRecipients()).toEqual(["thandi@example.co.za"]);
  });

  it("refuses a suppressed address with a visible reason and sends nothing", async () => {
    suppress("thandi@example.co.za", undefined, "complaint");
    const res = await reply();
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("email_suppressed");
    expect(body.error).toContain("thandi@example.co.za");
    expect(body.error).toContain("spam complaint");
    expect(wireRecipients()).toEqual([]);
  });
});
