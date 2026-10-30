import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";
import { mem, post, resetBookingHarness, seedEvent, seedPage, slot } from "@/test/booking-harness";

/**
 * Every post-commit booking path hands the event to the Google push — each
 * test drives the REAL path and asserts the push seam received this event.
 * (What the push then does is push.test.ts's job.)
 */

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/comms/resend", async () => (await h()).bookingMocks.resend());
vi.mock("@/lib/booking/lifecycle", async () => (await h()).bookingMocks.lifecycle());
vi.mock("@/lib/booking/contact-reconcile", async () => (await h()).bookingMocks.reconcile());
vi.mock("@/lib/automations/qstash", () => ({ verifyQStashSignature: async () => true }));
const auth = vi.hoisted(() => ({
  member: vi.fn(async (_req: Request, subAccountId: string) => ({ uid: "a", subAccountId, subAccountRole: "admin" })),
}));
vi.mock("@/lib/auth/require-tenancy", () => ({ requireSubAccountMember: auth.member }));
vi.mock("@/lib/server/contacts-service", () => ({ emitContactCreatedById: async () => undefined }));
const push = vi.hoisted(() => ({ now: vi.fn(async () => {}), later: vi.fn() }));
vi.mock("@/lib/google-calendar/push", () => ({
  pushBookingToGoogle: push.now,
  pushBookingToGoogleAfterResponse: push.later,
}));
vi.mock("@/lib/google-calendar/busy", () => ({
  loadGoogleBusyForPage: async () => [],
  loadGoogleBusyForEvent: async () => [],
}));

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  resetBookingHarness();
  push.now.mockClear();
  push.later.mockClear();
  auth.member.mockClear();
});

describe("push call sites", () => {
  it("book route → after the response", async () => {
    seedPage("p", { hosts: [{ uid: "a", name: "Ann" }] });
    const { POST } = await import("@/app/api/booking/[saId]/[slug]/book/route");
    const res = await POST(post({ slot: slot("09:00", "09:30"), name: "N", email: "n@example.com", phone: "+27600000000" }), {
      params: Promise.resolve({ saId: "sa1", slug: "p" }),
    });
    const { eventId } = await res.json();
    expect(push.later).toHaveBeenCalledWith(eventId);
  });

  it("mark-paid (bookings-service)", async () => {
    seedEvent("e1", "09:00", "09:30", { status: "awaiting_payment" });
    const { markBookingPaidServerSide } = await import("@/lib/server/bookings-service");
    expect((await markBookingPaidServerSide({ eventId: "e1", expectSubAccountId: "sa1", paidByUid: "a" })).ok).toBe(true);
    expect(push.now).toHaveBeenCalledWith("e1");
  });

  it("operator cancel (event-status-service) — and not a no-show", async () => {
    const { changeEventStatus } = await import("@/lib/server/event-status-service");
    seedEvent("e1", "09:00", "09:30");
    await changeEventStatus(mem.read("events/e1") as never, "no_show");
    await flushAfterResponse();
    expect(push.now).not.toHaveBeenCalled();
    seedEvent("e2", "09:00", "09:30");
    await changeEventStatus(mem.read("events/e2") as never, "cancelled");
    expect(push.now).toHaveBeenCalledWith("e2");
  });

  it("runRescheduleSideEffects (token + operator reschedule)", async () => {
    const { runRescheduleSideEffects } = await import("@/lib/booking/reschedule");
    seedEvent("e1", "09:00", "09:30");
    await runRescheduleSideEffects({
      event: mem.read("events/e1") as never,
      page: undefined,
      newRawToken: "t",
      publicEventUrl: "http://x/e/t",
      startAt: new Date(),
      endAt: new Date(),
      actor: "operator",
    });
    expect(push.now).toHaveBeenCalledWith("e1");
  });

  it("payment expiry (expire-step route)", async () => {
    seedEvent("e1", "09:00", "09:30", { status: "awaiting_payment" });
    const { POST } = await import("@/app/api/events/payment/expire-step/route");
    const req = new Request("http://x/api", { method: "POST", headers: { "Upstash-Signature": "sig" }, body: JSON.stringify({ eventId: "e1" }) });
    expect((await POST(req)).status).toBe(200);
    expect(mem.read("events/e1")?.status).toBe("cancelled");
    expect(push.now).toHaveBeenCalledWith("e1");
  });

  it("reassign (assign route)", async () => {
    seedPage("p", { hosts: [{ uid: "a", name: "Ann" }, { uid: "b", name: "Bob" }] });
    mem.seed("subAccounts/sa1/subAccountMembers/b", { uid: "b", status: "active", displayName: "Bob" });
    seedEvent("e1", "09:00", "09:30", { bookingPageSlug: "p", source: "booking_page", assignedToUid: "a" });
    const { POST } = await import("@/app/api/events/by-id/[id]/assign/route");
    const req = new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assignedToUid: "b", force: true }) });
    expect((await POST(req, params("e1"))).status).toBe(200);
    expect(push.now).toHaveBeenCalledWith("e1");
  });

  it("Retry sync (google-sync route): authorised against the EVENT's sub-account, then pushes; 30 s cooldown", async () => {
    seedEvent("e1", "09:00", "09:30", { subAccountId: "sa_other", googleSyncError: { message: "Not in Ann's Google Calendar: x" } });
    const { POST } = await import("@/app/api/events/by-id/[id]/google-sync/route");
    const retry = (id = "e1") => POST(new Request("http://x/api", { method: "POST" }), params(id));
    expect((await retry()).status).toBe(200);
    expect(auth.member).toHaveBeenCalledWith(expect.any(Request), "sa_other");
    expect(push.now).toHaveBeenCalledWith("e1");
    expect((await retry()).status).toBe(429);
    await flushAfterResponse();
    expect(push.now).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(Date.now() + 31_000));
    expect((await retry()).status).toBe(200);
    expect((await retry("nope")).status).toBe(404);
  });

  it("voice booking → after the tool reply", async () => {
    seedPage("p", { hosts: [{ uid: "a", name: "Ann" }] });
    const { bookVoiceSlot } = await import("@/lib/server/voice-booking-service");
    const res = await bookVoiceSlot({
      subAccountId: "sa1", agencyId: "ag1", page: mem.read("subAccounts/sa1/bookingPages/p") as never,
      startAtIso: new Date("2026-09-14T09:00:00Z").toISOString(), callerName: "C", callerPhone: "+27600000000", contactId: "c1",
    });
    expect(res.ok).toBe(true);
    expect(push.later).toHaveBeenCalledWith((res as { eventId: string }).eventId);
  });

  it("manage-link cancel (token cancel route)", async () => {
    const { issueEventToken } = await import("@/lib/booking/event-token");
    const { token, hash } = issueEventToken("e1");
    seedEvent("e1", "09:00", "09:30", { publicTokenHash: hash });
    const { POST } = await import("@/app/api/events/[token]/cancel/route");
    expect((await POST(new Request("http://x/api", { method: "POST" }), { params: Promise.resolve({ token }) })).status).toBe(200);
    expect(push.now).toHaveBeenCalledWith("e1");
  });
});
