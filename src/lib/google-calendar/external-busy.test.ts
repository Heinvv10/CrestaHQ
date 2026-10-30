import { beforeEach, describe, expect, it, vi } from "vitest";
import { at, mem, post, resetBookingHarness, seedEvent, seedPage, slot } from "@/test/booking-harness";

/**
 * Google busy reaches every re-verify through the resolver's externalBusy:
 * a slot a host is busy for in Google is refused at book, token reschedule
 * and voice confirm — and the same slot goes through when Google is free.
 */

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/comms/resend", async () => (await h()).bookingMocks.resend());
vi.mock("@/lib/booking/lifecycle", async () => (await h()).bookingMocks.lifecycle());
vi.mock("@/lib/booking/contact-reconcile", async () => (await h()).bookingMocks.reconcile());
vi.mock("@/lib/server/contacts-service", () => ({ emitContactCreatedById: async () => undefined }));
vi.mock("@/lib/google-calendar/push", () => ({
  pushBookingToGoogle: async () => undefined,
  pushBookingToGoogleAfterResponse: () => undefined,
}));
const google = vi.hoisted(() => ({ busy: [] as Array<{ startAt: Date; endAt: Date; hostUids: string[] }> }));
vi.mock("@/lib/google-calendar/busy", () => ({
  loadGoogleBusyForPage: async () => google.busy,
  loadGoogleBusyForEvent: async () => google.busy,
}));

const { issueEventToken } = await import("@/lib/booking/event-token");
const A = { uid: "a", name: "Ann" };

beforeEach(() => {
  resetBookingHarness();
  seedPage("p", { hosts: [A] });
  google.busy = [{ startAt: at("10:00"), endAt: at("10:30"), hostUids: ["a"] }];
});

describe("externalBusy at every re-verify", () => {
  it("book route", async () => {
    const { POST } = await import("@/app/api/booking/[saId]/[slug]/book/route");
    const book = (s: string, e: string) =>
      POST(post({ slot: slot(s, e), name: "N", email: "n@example.com", phone: "+27600000000" }), {
        params: Promise.resolve({ saId: "sa1", slug: "p" }),
      });
    expect((await book("10:00", "10:30")).status).toBe(409);
    expect((await book("10:30", "11:00")).status).toBe(200);
  });

  it("token reschedule", async () => {
    const { POST } = await import("@/app/api/events/[token]/reschedule/route");
    const { token, hash } = issueEventToken("mine");
    seedEvent("mine", "09:00", "09:30", { bookingPageSlug: "p", publicTokenHash: hash, assignedToUid: "a" });
    const move = (s: string, e: string, t: string) => POST(post({ slot: slot(s, e) }), { params: Promise.resolve({ token: t }) });
    expect((await move("10:00", "10:30", token)).status).toBe(409);
    const ok = await move("10:30", "11:00", token);
    expect(ok.status).toBe(200);
    expect((mem.read("events/mine")?.startAt as Date).getTime()).toBe(at("10:30").getTime());
  });

  it("voice confirm", async () => {
    mem.seed("contacts/c1", { subAccountId: "sa1", name: "C" });
    const { bookAgentSlot, listAgentSlots } = await import("@/lib/server/agent-booking-service");
    const page = mem.read("subAccounts/sa1/bookingPages/p") as never;
    const book = (hhmm: string) =>
      bookAgentSlot({
    channel: "phone", subAccountId: "sa1", agencyId: "ag1", page, startAtIso: at(hhmm).toISOString(), name: "C", phone: "+27600000000", contactId: "c1" });
    expect(await book("10:00")).toEqual({ ok: false, code: "slot_taken" });
    expect((await book("10:30")).ok).toBe(true);
    const listed = (await listAgentSlots("sa1", page)).map((s) => s.startAt.getTime());
    expect(listed).not.toContain(at("10:00").getTime());
  });
});
