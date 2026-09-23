import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every booking side effect loads the event's contact by id and emails it /
 * writes its timeline. A legacy event may still hold a contact id from
 * ANOTHER sub-account (written before the rules checked it), and the operator
 * cancel is triggerable by the attacker's own tenant — so each path must
 * treat that contact as absent: no email on the wire, no activity row.
 *
 * Each case runs twice over the same fixture, differing only in the
 * contact's `subAccountId`: the own-tenant run must email + record (so the
 * foreign run's silence is not vacuous). Real routes/services, real
 * sendEmail and lifecycle, in-memory Firestore; only the SMTP wire,
 * workflows, webhooks, QStash and Google push are stubbed.
 */

const s = () => import("@/test/email-suppression-seam");
vi.mock("@/lib/firebase/admin", async () => (await s()).seamMocks.admin());
vi.mock("@/lib/comms/smtp", async (orig) => (await s()).seamMocks.smtp(orig));
vi.mock("@/lib/server/email-conversations", async () => (await s()).seamMocks.conversations());
vi.mock("@/lib/server/usage-meter", async (orig) => (await s()).seamMocks.usage(orig));
vi.mock("@/lib/automations/qstash", () => ({
  verifyQStashSignature: async () => true,
  qstashIsConfigured: () => false,
  publishCallback: async () => null,
}));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: async () => ({ enrolled: [], skipped: [], reason: null }),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/google-calendar/push", () => ({
  pushBookingToGoogle: async () => undefined,
  removeBookingFromGoogleBeforeDelete: async () => ({ ok: true }),
}));
vi.mock("@/lib/booking/event-token", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  verifyEventToken: () => ({ eventId: "e1" }),
  hashEventToken: () => "hash_tok",
}));

const { SA, AGENCY, mem, resetSeam, wireRecipients } = await s();
const { POST: visitorCancel } = await import("@/app/api/events/[token]/cancel/route");
const { POST: expireStep } = await import("@/app/api/events/payment/expire-step/route");
const { changeEventStatus } = await import("@/lib/server/event-status-service");
const { markBookingPaidServerSide } = await import("@/lib/server/bookings-service");
const { runRescheduleSideEffects } = await import("./reschedule");
const { recordBookingActivity } = await import("./lifecycle");

const ts = (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime() });
const start = () => new Date(Date.now() + 24 * 3600_000);

function seed(status: string, contactSub: string) {
  const at = start();
  mem.seed("events/e1", {
    agencyId: AGENCY, subAccountId: SA, status, title: "Intro", contactId: "c1",
    publicTokenHash: "hash_tok", startAt: ts(at), endAt: ts(new Date(at.getTime() + 1800_000)),
  });
  mem.seed("contacts/c1", {
    name: "Thandi", email: "thandi@example.co.za", agencyId: AGENCY, subAccountId: contactSub,
  });
}
const event = () => ({ id: "e1", ...mem.read("events/e1") }) as never;
const activities = () => mem.list("contacts/c1/activities");

const PATHS: [string, string, () => Promise<unknown>][] = [
  ["visitor cancel", "scheduled", () =>
    visitorCancel(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ token: "tok" }) })],
  ["payment expiry", "awaiting_payment", () =>
    expireStep(new Request("http://x", {
      method: "POST", headers: { "Upstash-Signature": "sig" }, body: JSON.stringify({ eventId: "e1" }),
    }))],
  ["operator cancel", "scheduled", () => changeEventStatus(event(), "cancelled")],
  ["mark paid", "awaiting_payment", () =>
    markBookingPaidServerSide({ eventId: "e1", expectSubAccountId: SA, paidByUid: "admin1" })],
  ["reschedule", "scheduled", () => {
    const at = start();
    return runRescheduleSideEffects({
      event: event(), page: undefined, newRawToken: "tok2", publicEventUrl: "https://x/e/tok2",
      startAt: at, endAt: new Date(at.getTime() + 1800_000), actor: "visitor" as never,
    });
  }],
];

beforeEach(() => {
  resetSeam();
  process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-not-a-real-key";
});

describe.each(PATHS)("%s", (_name, status, run) => {
  it("emails and records for the sub-account's own contact (control)", async () => {
    seed(status, SA);
    await run();
    expect(wireRecipients()).toEqual(["thandi@example.co.za"]);
    expect(activities().length).toBeGreaterThan(0);
  });

  it("neither emails nor records for a contact in another sub-account", async () => {
    seed(status, "sa_other");
    await run();
    expect(wireRecipients()).toEqual([]);
    expect(activities()).toEqual([]);
  });
});

it("recordBookingActivity skips a contact in another sub-account", async () => {
  seed("scheduled", "sa_other");
  await recordBookingActivity(
    { id: "e1", title: "Intro", contactId: "c1", bookingPageSlug: null, subAccountId: SA },
    "booking_cancelled",
  );
  expect(activities()).toEqual([]);
  mem.seed("contacts/c1", { name: "Thandi", subAccountId: SA });
  await recordBookingActivity(
    { id: "e1", title: "Intro", contactId: "c1", bookingPageSlug: null, subAccountId: SA },
    "booking_cancelled",
  );
  expect(activities()).toHaveLength(1);
});
