import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mem, resetBookingHarness, seedEvent, seedPage, at } from "@/test/booking-harness";
import { flushAfterResponse } from "@/lib/server/after-response";
import type { AgentBookInput } from "./agent-booking-types";

const fx = vi.hoisted(() => ({
  email: vi.fn(async (_input: unknown) => undefined), configured: vi.fn(() => true),
  push: vi.fn(), meet: vi.fn(async () => ({ meetUrl: "https://meet.google.com/abc", pending: false })),
  trigger: vi.fn((..._args: unknown[]) => undefined), activity: vi.fn(), webhook: vi.fn(), contact: vi.fn(), reminders: vi.fn(),
  sms: vi.fn(async (_input: unknown) => ({ sent: true as const })),
}));
vi.mock("@/lib/firebase/admin", async () => { const { mem } = await import("@/test/booking-harness"); return { getAdminDb: () => mem.db }; });
vi.mock("@/lib/comms/resend", () => ({ emailIsConfigured: fx.configured, sendEmail: fx.email, tenantFrom: () => "host@example.com" }));
vi.mock("@/lib/google-calendar/push", () => ({ pushBookingToGoogleAfterResponse: fx.push, pushBookingAndGetMeetUrlWithin: fx.meet }));
vi.mock("@/lib/booking/lifecycle", () => ({ fireBookingTrigger: fx.trigger, recordBookingActivity: fx.activity, emitBookingWebhook: fx.webhook, scheduleEventReminders: fx.reminders }));
vi.mock("@/lib/server/contacts-service", () => ({ emitContactCreatedById: fx.contact }));
vi.mock("@/lib/booking/sms", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/booking/sms")>(), sendBookingSms: fx.sms }));
const { bookAgentSlot, listAgentSlots } = await import("./agent-booking-service");
const A = { uid: "a", name: "Ann" }, B = { uid: "b", name: "Bob" };
function input(over: Partial<AgentBookInput> = {}): AgentBookInput {
  return { subAccountId: "sa1", agencyId: "ag1", page: over.page ?? seedPage("p"), channel: "phone", startAtIso: at("09:00").toISOString(), name: "Caller", phone: "+27821234567", contactId: "c1", ...over };
}
beforeEach(() => {
  resetBookingHarness(); vi.clearAllMocks(); fx.configured.mockReturnValue(true);
  mem.seed("contacts/c1", { subAccountId: "sa1", name: "", email: "", phone: "" });
  for (const h of [A, B]) mem.seed(`subAccounts/sa1/subAccountMembers/${h.uid}`, { ...h, status: "active", displayName: h.name, email: `${h.uid}@example.com` });
});
afterEach(async () => { await flushAfterResponse(); vi.useRealTimers(); });

describe("retained engine and lifecycle", () => {
  it("round-robin picks the least loaded; a single page does not become round-robin", async () => {
    seedEvent("load", "10:00", "10:30", { assignedToUid: "a" });
    let req = input({ page: seedPage("rr", { calendarType: "round_robin", hosts: [A, B] }) });
    expect(await bookAgentSlot(req)).toMatchObject({ ok: true, assignedToName: "Bob" });
    req = input({ page: seedPage("single", { calendarType: "personal", hosts: [A, B] }), startAtIso: at("11:00").toISOString() });
    expect(await bookAgentSlot(req)).toMatchObject({ ok: true, assignedToName: "Ann" });
  });
  it("never silently assigns another host when a named host is busy", async () => {
    const req = input({ page: seedPage("rr", { calendarType: "round_robin", hosts: [A, B], allowHostSelection: true }), hostUid: "a" });
    seedEvent("busy", "09:00", "09:30", { assignedToUid: "a" });
    expect(await bookAgentSlot(req)).toEqual({ ok: false, code: "slot_taken" });
    expect(await bookAgentSlot({ ...req, hostUid: "b" })).toMatchObject({ ok: true, assignedToName: "Bob" });
  });
  it("keeps day caps and date-specific availability on listing and confirm", async () => {
    const req = input({ page: seedPage("p", { maxPerDay: 1 }) });
    seedEvent("used", "11:00", "11:30", { bookingPageSlug: "p", status: "completed" });
    expect(await listAgentSlots("sa1", req.page)).toEqual([]);
    expect(await bookAgentSlot(req)).toEqual({ ok: false, code: "slot_taken" });
    mem.clear(); resetBookingHarness(); mem.seed("contacts/c1", { subAccountId: "sa1" });
    const page = seedPage("p", { dateOverrides: [{ date: "2026-09-14", ranges: [{ startMinute: 600, endMinute: 660 }] }] });
    expect((await listAgentSlots("sa1", page))[0].startAt).toEqual(at("10:00"));
    expect(await bookAgentSlot({ ...req, page })).toEqual({ ok: false, code: "slot_taken" });
    expect(await bookAgentSlot({ ...req, page, startAtIso: at("10:00").toISOString() })).toMatchObject({ ok: true });
  });
  it("pushes, fires both triggers, notifies every collective host, and stamps the call", async () => {
    const req = input({ page: seedPage("col", { calendarType: "collective", hosts: [A, B] }), callId: "call1" });
    const result = await bookAgentSlot(req);
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error("booking refused");
    await flushAfterResponse();
    expect(fx.push).toHaveBeenCalledWith(result.eventId);
    expect(fx.trigger.mock.calls.map(c => c[1])).toEqual(["event_booked", "event_confirmed"]);
    expect(fx.activity).toHaveBeenCalledWith(expect.objectContaining({ subAccountId: "sa1", contactId: "c1" }), "booking_page_booked");
    expect(fx.email.mock.calls.map(c => (c[0] as { to: string }).to).sort()).toEqual(["a@example.com", "b@example.com"]);
    expect(mem.read("subAccounts/sa1/voiceCalls/call1")).toMatchObject({ voiceBooking: { attemptedAt: expect.any(String), booked: { eventId: result.eventId } } });
    expect(fx.sms).not.toHaveBeenCalled(); expect(fx.reminders).not.toHaveBeenCalled();
  });
  it("does not send host or customer emails when this tenant has no configured email rail", async () => {
    fx.configured.mockReturnValue(false);
    expect(await bookAgentSlot(input({ channel: "web-text", email: "c@example.com", page: seedPage("p", { hosts: [A] }) }))).toMatchObject({ ok: true });
    await flushAfterResponse(); expect(fx.email).not.toHaveBeenCalled();
    expect(fx.configured).toHaveBeenCalledWith(expect.objectContaining({ agencyId: "ag1" }));
  });
  it("creates a phone-first contact transactionally and emits contact.created after response", async () => {
    const result = await bookAgentSlot(input({ contactId: null, callId: "call2" }));
    expect(result.ok).toBe(true); await flushAfterResponse();
    expect(mem.list("contacts").filter(c => c.source === "voice")).toHaveLength(1);
    expect(fx.contact).toHaveBeenCalledOnce();
  });
  it("concurrent phone retries without a matched contact create one contact and one booking", async () => {
    const req = input({ contactId: null, callId: "retry" });
    const [a, b] = await Promise.all([bookAgentSlot(req), bookAgentSlot(req)]);
    expect(a).toMatchObject({ ok: true }); expect(b).toEqual(a); await flushAfterResponse();
    expect(mem.list("events")).toHaveLength(1);
    expect(mem.list("contacts").filter(c => c.source === "voice")).toHaveLength(1);
    expect(fx.contact).toHaveBeenCalledOnce(); expect(fx.trigger).toHaveBeenCalledTimes(2);
  });
  it("stamps attemptedAt on a slot conflict without a successful stamp", async () => {
    const req = input({ callId: "failed" }); seedEvent("busy", "09:00", "09:30");
    expect(await bookAgentSlot(req)).toEqual({ ok: false, code: "slot_taken" });
    expect(mem.read("subAccounts/sa1/voiceCalls/failed")).toMatchObject({ voiceBooking: { attemptedAt: expect.any(String) } });
    expect((mem.read("subAccounts/sa1/voiceCalls/failed")?.voiceBooking as object)).not.toHaveProperty("booked");
  });
});

describe("new channel behavior", () => {
  it.each(["web-text", "web-voice", "messaging"] as const)("%s fills blanks and sends ICS, text and reminders once on replay", async channel => {
    const req = input({ channel, email: "CALLER@EXAMPLE.COM", phone: "0821234567", address: "12 Main St", page: seedPage("p", { location: { type: "their_address", value: null }, remindersEnabled: true, smsRemindersEnabled: true }), intakeAnswers: [{ label: "Topic", value: "Quote" }] });
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Fixture", defaultPhoneCountry: "ZA" });
    const [first, second] = await Promise.all([bookAgentSlot(req), bookAgentSlot(req)]);
    expect(first).toMatchObject({ ok: true }); expect(second).toEqual(first);
    await flushAfterResponse();
    expect(mem.list("events")).toHaveLength(1);
    expect(mem.read("contacts/c1")).toMatchObject({ name: "Caller", email: "caller@example.com", phone: "+27821234567" });
    expect(mem.list("events")[0]).toMatchObject({ createdByUid: channel === "messaging" ? "messaging-agent" : "web-chat-agent", location: "At your address: 12 Main St", notes: expect.stringContaining("Topic: Quote") });
    expect(fx.email).toHaveBeenCalledOnce();
    expect(fx.email).toHaveBeenCalledWith(expect.objectContaining({ subAccount: expect.objectContaining({ agencyId: "ag1" }), attachments: [expect.objectContaining({ filename: "invite.ics" })] }));
    const content = (fx.email.mock.calls[0][0] as { attachments: { content: string }[] }).attachments[0].content;
    expect(Buffer.from(content, "base64").toString()).toContain("BEGIN:VCALENDAR");
    expect(fx.reminders).toHaveBeenCalledOnce(); expect(fx.sms).toHaveBeenCalledOnce();
    expect(fx.sms).toHaveBeenCalledWith(expect.objectContaining({ claimPath: expect.stringMatching(/^events\/ab_.*\/reminderSends\/sms_confirm$/), body: expect.not.stringContaining("12 Main St") }));
    expect(fx.sms.mock.calls[0][0]).not.toHaveProperty("selfTriggeredBookingAt");
  });
  it("rechecks tenant ownership before deferred follow-ups", async () => {
    const { sendConversationBookingFollowUps } = await import("./agent-booking-follow-ups");
    const page = seedPage("p", { smsRemindersEnabled: true });
    mem.seed("contacts/foreign", { subAccountId: "other" });
    await sendConversationBookingFollowUps({ subAccountId: "sa1", page, contactId: "foreign", eventId: "event1",
      created: { title: "Booking", assignedToUid: null, assignedToName: null }, rawToken: "token",
      slotStart: at("09:00"), slotEnd: at("09:30"), name: "Visitor", email: "c@example.com", phone: "",
      notes: "", locationText: "", fallbackName: "Visitor" });
    await flushAfterResponse(); expect(fx.email).not.toHaveBeenCalled(); expect(fx.sms).not.toHaveBeenCalled();
    expect(fx.reminders).not.toHaveBeenCalled(); expect(fx.push).not.toHaveBeenCalled();
  });
  it("uses our bounded Meet push before the confirmation email", async () => {
    const req = input({ channel: "web-text", email: "c@example.com", page: seedPage("p", { location: { type: "google_meet", value: null }, googleMeet: true }) });
    expect(await bookAgentSlot(req)).toMatchObject({ ok: true }); await flushAfterResponse();
    expect(fx.meet).toHaveBeenCalledOnce();
    expect(fx.email).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("https://meet.google.com/abc") }));
    expect(fx.meet.mock.invocationCallOrder[0]).toBeLessThan(fx.email.mock.invocationCallOrder[0]);
  });
});
