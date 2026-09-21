import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Booking reminder against the suppression list: real route → real
 * sendEmail → real lookup. Nobody is watching a cron, so a suppressed
 * reminder is written to the contact's timeline for the host to see.
 */

const s = () => import("@/test/email-suppression-seam");
vi.mock("@/lib/firebase/admin", async () => (await s()).seamMocks.admin());
vi.mock("@/lib/comms/smtp", async (orig) => (await s()).seamMocks.smtp(orig));
vi.mock("@/lib/server/email-conversations", async () => (await s()).seamMocks.conversations());
vi.mock("@/lib/server/usage-meter", async (orig) => (await s()).seamMocks.usage(orig));
vi.mock("@/lib/automations/qstash", () => ({ verifyQStashSignature: async () => true }));

const { SA, AGENCY, mem, resetSeam, suppress, wireRecipients } = await s();
const { POST } = await import("./route");

const ts = (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime() });
const remind = () =>
  POST(
    new Request("https://app.test/api/events/reminder/step", {
      method: "POST",
      headers: { "Upstash-Signature": "sig" },
      body: JSON.stringify({ eventId: "e1", offsetMinutes: 60, token: "tok" }),
    })
  );

beforeEach(() => {
  resetSeam();
  const start = new Date(Date.now() + 2 * 3600_000);
  mem.seed("events/e1", {
    agencyId: AGENCY,
    subAccountId: SA,
    status: "scheduled",
    title: "Intro",
    contactId: "c1",
    startAt: ts(start),
    endAt: ts(new Date(start.getTime() + 1800_000)),
  });
  mem.seed("contacts/c1", { name: "Thandi", email: "thandi@example.co.za", agencyId: AGENCY, subAccountId: SA });
});

describe("booking reminder", () => {
  it("is sent to an address that is not suppressed, with no activity", async () => {
    await remind();
    expect(wireRecipients()).toEqual(["thandi@example.co.za"]);
    expect(mem.list("contacts/c1/activities")).toEqual([]);
  });

  it("is refused for a suppressed contact and recorded on their timeline", async () => {
    suppress("thandi@example.co.za");
    await remind();
    expect(wireRecipients()).toEqual([]);
    expect(mem.list("contacts/c1/activities")).toEqual([
      expect.objectContaining({
        type: "email_suppressed",
        content: expect.stringContaining("Booking reminder not sent"),
        meta: expect.objectContaining({ eventId: "e1", reason: "hard_bounce" }),
      }),
    ]);
  });
});
