import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mem, resetBookingHarness, seedEvent, seedPage, at, NOW } from "@/test/booking-harness";
import { flushAfterResponse } from "@/lib/server/after-response";
import type { AgentBookInput } from "./agent-booking-types";
const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/comms/resend", async () => (await h()).bookingMocks.resend());
vi.mock("@/lib/booking/lifecycle", async () => (await h()).bookingMocks.lifecycle());
vi.mock("@/lib/server/contacts-service", () => ({ emitContactCreatedById: vi.fn() }));
vi.mock("@/lib/google-calendar/push", () => ({ pushBookingToGoogleAfterResponse: vi.fn() }));
const { bookAgentSlot, getAgentBookingContext, listAgentSlots, listRescheduleSlots, loadChangeableBookings, findRecentAgentBooking } = await import("./agent-booking-service");
const req = (): AgentBookInput => ({ subAccountId: "sa1", agencyId: "ag1", page: seedPage("p"), channel: "phone", name: "Caller", phone: "+27821234567", startAtIso: at("09:00").toISOString(), contactId: "c1" });
const ts = (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime() });
beforeEach(() => { resetBookingHarness(); mem.seed("contacts/c1", { subAccountId: "sa1", name: "" }); });
afterEach(async () => { await flushAfterResponse(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("fail-closed entry guards", () => {
  it.each(["subAccountId", "agencyId", "contactId", "callId"] as const)("rejects malformed %s before any path read", async field => {
    const input = { ...req(), [field]: "bad/path" };
    const read = vi.spyOn(mem.db, "doc");
    expect(await bookAgentSlot(input)).toEqual({ ok: false, code: "error" });
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects malformed page and context ids before reading paths", async () => {
    const input = req(); input.page.slug = "bad/path";
    const read = vi.spyOn(mem.db, "doc");
    expect(await bookAgentSlot(input)).toEqual({ ok: false, code: "error" });
    expect(await getAgentBookingContext("bad/path", "p")).toBeNull();
    expect(await getAgentBookingContext("sa1", "bad/path")).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["draft", "paid", "service", "foreign", "wrong-slug"])("refuses %s pages even if the caller passes an old published page", async kind => {
    const input = req();
    const patch = kind === "draft" ? { status: "draft" } : kind === "paid" ? { payment: { amount: 50 } } : kind === "service" ? { calendarType: "service" } : kind === "foreign" ? { subAccountId: "other" } : { slug: "other" };
    mem.seed("subAccounts/sa1/bookingPages/p", { ...input.page, ...patch });
    expect(await bookAgentSlot(input)).toEqual({ ok: false, code: "error" });
    expect(await listAgentSlots("sa1", input.page)).toEqual([]);
    expect(mem.list("events")).toEqual([]);
  });
  it.each(["missing", "foreign"])("refuses a %s contact without changing it", async kind => {
    const input = req(); mem.seed("contacts/foreign", { subAccountId: "other", name: "" }); input.contactId = kind;
    expect(await bookAgentSlot(input)).toEqual({ ok: false, code: "error" });
    expect(mem.read("contacts/foreign")?.name).toBe(""); expect(mem.list("events")).toEqual([]);
  });
  it("requires reconciled contacts for website and messaging channels", async () => {
    for (const channel of ["web-text", "web-voice", "messaging"] as const) expect(await bookAgentSlot({ ...req(), channel, contactId: null })).toEqual({ ok: false, code: "error" });
    expect(mem.list("contacts")).toHaveLength(1); expect(mem.list("events")).toEqual([]);
  });
  it("rejects a mismatched agency or missing workspace", async () => {
    const input = req();
    expect(await bookAgentSlot({ ...input, agencyId: "other" })).toEqual({ ok: false, code: "error" });
    mem.seed("subAccounts/sa1", { agencyId: "other" });
    expect(await bookAgentSlot(input)).toEqual({ ok: false, code: "error" });
  });
  it("refuses a page carrying another agency before any contact mutation", async () => {
    const input = req(); mem.seed("subAccounts/sa1/bookingPages/p", { ...input.page, agencyId: "other" });
    expect(await bookAgentSlot(input)).toEqual({ ok: false, code: "error" });
    expect(mem.read("contacts/c1")?.name).toBe("");
  });
  it("rechecks the linked contact inside the booking transaction", async () => {
    const input = req(); const original = mem.db.runTransaction.bind(mem.db);
    vi.spyOn(mem.db, "runTransaction").mockImplementation(async fn => {
      mem.seed("contacts/c1", { subAccountId: "other" }); return original(fn);
    });
    expect(await bookAgentSlot(input)).toEqual({ ok: false, code: "slot_taken" });
    expect(mem.list("events")).toEqual([]);
  });
  it.each(["bad", "2026-09-14T05:00:00Z"])("rejects invalid or past starts: %s", async startAtIso => {
    expect(await bookAgentSlot({ ...req(), startAtIso })).toEqual({ ok: false, code: "invalid_slot" });
    expect(mem.list("events")).toEqual([]);
  });
  it("rechecks page state inside the create transaction", async () => {
    const input = req(); const original = mem.db.runTransaction.bind(mem.db);
    vi.spyOn(mem.db, "runTransaction").mockImplementation(async fn => {
      mem.seed("subAccounts/sa1/bookingPages/p", { ...input.page, status: "draft" });
      return original(fn);
    });
    expect(await bookAgentSlot(input)).toEqual({ ok: false, code: "slot_taken" });
    expect(mem.list("events")).toEqual([]);
  });
});

describe("scoped change and replay reads", () => {
  function booking(id: string, over: Record<string, unknown> = {}) {
    seedPage("p"); seedEvent(id, "09:00", "09:30", { source: "booking_page", bookingPageSlug: "p", contactId: "c1", createdAt: ts(NOW), ...over });
  }
  it("loads only upcoming scheduled bookings for the requested tenant/contact", async () => {
    booking("mine"); booking("foreign", { subAccountId: "other" }); booking("other-contact", { contactId: "c2" });
    booking("cancelled", { status: "cancelled" }); booking("imported", { source: "google" });
    booking("past", { startAt: ts(at("05:00")) }); booking("bad-page", { bookingPageSlug: "bad/path" });
    const eventIds = ["mine", "foreign", "other-contact", "cancelled", "imported", "past", "bad-page"];
    expect((await loadChangeableBookings({ subAccountId: "sa1", contactId: "c1", eventIds })).map(b => b.eventId)).toEqual(["mine"]);
    expect((await loadChangeableBookings({ subAccountId: "sa1", contactId: "c1" })).map(b => b.eventId)).toEqual(["mine"]);
    expect(await loadChangeableBookings({ subAccountId: "sa1" })).toEqual([]);
  });
  it("does not read invalid event ids, contact ids or sub-account ids", async () => {
    const all = vi.spyOn(mem.db, "getAll"), doc = vi.spyOn(mem.db, "doc");
    expect(await loadChangeableBookings({ subAccountId: "sa1", eventIds: ["bad/path"] })).toEqual([]);
    expect(await loadChangeableBookings({ subAccountId: "bad/path", eventIds: ["x"] })).toEqual([]);
    expect(await loadChangeableBookings({ subAccountId: "sa1", contactId: "bad/path" })).toEqual([]);
    expect(await listRescheduleSlots("sa1", seedPage("p"), { id: "bad/path" })).toEqual([]);
    expect(all).not.toHaveBeenCalled(); expect(doc).not.toHaveBeenCalled();
  });
  it("replay finder accepts only recent scheduled events at the exact time and page", async () => {
    booking("mine");
    const args = { subAccountId: "sa1", contactId: "c1", pageSlug: "p", startAtIso: at("09:00").toISOString(), withinMs: 300000 };
    expect(await findRecentAgentBooking(args)).toMatchObject({ eventId: "mine" });
    for (const patch of [{ status: "cancelled" }, { source: "google" }, { createdAt: ts(new Date(NOW.getTime() - 300001)) }, { createdAt: ts(new Date(NOW.getTime() + 1)) }, { startAt: ts(at("10:00")) }, { contactId: "c2" }, { subAccountId: "other" }, { bookingPageSlug: "other" }]) {
      booking("mine", patch); expect(await findRecentAgentBooking(args)).toBeNull();
    }
    booking("mine");
    expect(await findRecentAgentBooking({ ...args, withinMs: -1 })).toBeNull();
    expect(await findRecentAgentBooking({ ...args, withinMs: Number.NaN })).toBeNull();
    expect(await findRecentAgentBooking({ ...args, pageSlug: "bad/path" })).toBeNull();
    expect(await findRecentAgentBooking({ ...args, startAtIso: "bad" })).toBeNull();
  });
  it("reschedule offers stay with assigned hosts and ignore their own booking", async () => {
    const page = seedPage("rr", { calendarType: "round_robin", hosts: [{ uid: "a", name: "Ann" }, { uid: "b", name: "Bob" }] });
    seedEvent("mine", "09:00", "09:30", { source: "booking_page", bookingPageSlug: "rr", assignedToUid: "a" });
    seedEvent("busy-a", "10:00", "10:30", { assignedToUid: "a" });
    const slots = await listRescheduleSlots("sa1", page, { id: "mine", assignedToUid: "b" });
    expect(slots.map(s => s.startAt.getTime())).toContain(at("09:00").getTime());
    expect(slots.map(s => s.startAt.getTime())).not.toContain(at("10:00").getTime());
    mem.seed("subAccounts/other/bookingPages/rr", { ...page, subAccountId: "other" });
    expect(await listRescheduleSlots("other", page, { id: "mine" })).toEqual([]);
  });
  it("refuses change-slot reads for non-bookings, wrong pages, cancelled events or departed hosts", async () => {
    const page = seedPage("p", { hosts: [{ uid: "a", name: "Ann" }] });
    for (const over of [{ source: "manual" }, { source: "google" }, { bookingPageSlug: "other" }, { status: "cancelled" }, { assignedToUid: "gone" }]) {
      seedEvent("mine", "09:00", "09:30", { source: "booking_page", bookingPageSlug: "p", assignedToUid: "a", ...over });
      expect(await listRescheduleSlots("sa1", page, { id: "mine" })).toEqual([]);
    }
  });
  it("does not expose a page with a mismatched tenant in changeable bookings", async () => {
    booking("mine"); const page = mem.read("subAccounts/sa1/bookingPages/p");
    mem.seed("subAccounts/sa1/bookingPages/p", { ...page, subAccountId: "other" });
    expect(await loadChangeableBookings({ subAccountId: "sa1", eventIds: ["mine"] })).toEqual([]);
  });
  it("cancelled or moved deterministic bookings are never replayed as a new success", async () => {
    const input = req(); const first = await bookAgentSlot(input); expect(first.ok).toBe(true);
    if (!first.ok) throw Error("booking failed");
    await mem.db.doc(`events/${first.eventId}`).update({ startAt: at("10:00"), endAt: at("10:30") });
    expect(await bookAgentSlot(input)).toEqual({ ok: false, code: "slot_taken" });
    await mem.db.doc(`events/${first.eventId}`).update({ status: "cancelled" });
    expect(await bookAgentSlot(input)).toEqual({ ok: false, code: "slot_taken" });
    expect(mem.list("events")).toHaveLength(1);
  });
});
