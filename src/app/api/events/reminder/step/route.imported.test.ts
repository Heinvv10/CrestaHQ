import { beforeEach, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * An event imported from a member's Google Calendar is their own meeting,
 * not a booking: a reminder callback for it emails nobody — not even the
 * contact it is linked to. It carries no `publicTokenHash`, so the rotated-
 * token check cannot be what stops it.
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

const ts = (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime() });
const remind = (token: string) =>
  POST(
    new Request("https://app.test/api/events/reminder/step", {
      method: "POST",
      headers: { "Upstash-Signature": "sig" },
      body: JSON.stringify({ eventId: "e1", offsetMinutes: 60, token }),
    }),
  );

function seed(over: Record<string, unknown>) {
  const start = new Date(Date.now() + 2 * 3600_000);
  mem.seed("events/e1", {
    agencyId: AGENCY,
    subAccountId: SA,
    status: "scheduled",
    title: "Intro",
    contactId: "c1",
    startAt: ts(start),
    endAt: ts(new Date(start.getTime() + 1800_000)),
    ...over,
  });
}

beforeEach(() => {
  resetSeam();
  process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-not-a-real-key";
  mem.seed("contacts/c1", { name: "Thandi", email: "thandi@example.co.za", agencyId: AGENCY, subAccountId: SA });
});

it("emails nobody for an imported Google event", async () => {
  seed({ source: "google" });
  const res = await remind(issueEventToken("e1").token);
  expect(await res.json()).toEqual({ ok: true, skipped: "imported" });
  await flushAfterResponse();
  expect(smtpSend).not.toHaveBeenCalled();
});

it("still reminds for the same event when it is a booking (control)", async () => {
  const issued = issueEventToken("e1");
  seed({ source: "booking_page", publicTokenHash: issued.hash });
  expect((await remind(issued.token)).status).toBe(200);
  await flushAfterResponse();
  expect(smtpSend).toHaveBeenCalledTimes(1);
});
