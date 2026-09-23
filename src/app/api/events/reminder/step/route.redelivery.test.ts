import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * QStash delivers at least once. A redelivered reminder must not email the
 * visitor twice, and a send that failed for a reason that may clear must
 * answer 5xx so QStash retries it — it used to be logged and 200'd, so the
 * reminder was simply lost.
 */

const s = () => import("@/test/email-suppression-seam");
vi.mock("@/lib/firebase/admin", async () => (await s()).seamMocks.admin());
vi.mock("@/lib/comms/smtp", async (orig) => (await s()).seamMocks.smtp(orig));
vi.mock("@/lib/server/email-conversations", async () => (await s()).seamMocks.conversations());
vi.mock("@/lib/server/usage-meter", async (orig) => (await s()).seamMocks.usage(orig));
vi.mock("@/lib/automations/qstash", () => ({ verifyQStashSignature: async () => true }));

const { SA, AGENCY, mem, resetSeam, smtpSend } = await s();
const { POST } = await import("./route");
const { issueEventToken } = await import("@/lib/booking/event-token");
const { SmtpError } = await import("@/lib/comms/smtp");

const ts = (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime() });
let token = "";
const remind = (offsetMinutes = 60, tok = token) =>
  POST(
    new Request("https://app.test/api/events/reminder/step", {
      method: "POST",
      headers: { "Upstash-Signature": "sig" },
      body: JSON.stringify({ eventId: "e1", offsetMinutes, token: tok }),
    }),
  );

beforeEach(() => {
  resetSeam();
  process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-not-a-real-key";
  const issued = issueEventToken("e1");
  token = issued.token;
  const start = new Date(Date.now() + 2 * 3600_000);
  mem.seed("events/e1", {
    agencyId: AGENCY,
    subAccountId: SA,
    status: "scheduled",
    title: "Intro",
    contactId: "c1",
    publicTokenHash: issued.hash,
    startAt: ts(start),
    endAt: ts(new Date(start.getTime() + 1800_000)),
  });
  mem.seed("contacts/c1", { name: "Thandi", email: "thandi@example.co.za", agencyId: AGENCY, subAccountId: SA });
});

describe("a redelivered reminder", () => {
  it("is sent once", async () => {
    expect((await remind()).status).toBe(200);
    expect((await remind()).status).toBe(200);
    await Promise.all([remind(), remind()]);
    expect(smtpSend).toHaveBeenCalledTimes(1);
  });

  it("does not stop a different offset, or the same offset after a reschedule", async () => {
    await remind(60);
    await remind(1440);
    const moved = issueEventToken("e1");
    mem.seed("events/e1", { ...mem.read("events/e1"), publicTokenHash: moved.hash });
    await remind(60, moved.token);
    expect(smtpSend).toHaveBeenCalledTimes(3);
  });
});

describe("a failed send", () => {
  it("answers 5xx on a failure that may clear, and the retry sends", async () => {
    smtpSend.mockRejectedValueOnce(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }));
    expect((await remind()).status).toBe(503);
    expect((await remind()).status).toBe(200);
    expect(smtpSend).toHaveBeenCalledTimes(2);
  });

  it("answers 200 on a failure a retry cannot fix", async () => {
    smtpSend.mockRejectedValueOnce(new SmtpError("Invalid recipient email address."));
    expect((await remind()).status).toBe(200);
    await remind();
    expect(smtpSend).toHaveBeenCalledTimes(1);
  });
});
