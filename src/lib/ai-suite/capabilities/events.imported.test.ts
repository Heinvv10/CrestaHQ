import { beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { mem, seedTenants } from "@/test/chat-route-harness";

/**
 * The assistant never reads or acts on an event imported from a member's
 * Google Calendar — it is their own calendar, not CRM data. Through the real
 * capabilities: find_events and find_awaiting_payment_bookings leave it out
 * (and 60 of them can't crowd real events out of the shown 50), and every
 * tool that resolves an event by id refuses it.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/chat-route-harness")).adminMock());
vi.mock("@/lib/ai-suite/usage", () => ({ recordAiSuiteUsage: async () => undefined }));
vi.mock("@/lib/ai-suite/audit", () => ({ recordAiSuiteAction: async () => undefined }));

const { getCapability } = await import("@/lib/ai-suite/capabilities");

const ctx = { uid: "u1", email: "", displayName: "", agencyId: "ag1", subAccountId: "sa1", subAccountRole: "admin" } as const;
const inHours = (h: number) => Timestamp.fromMillis(Date.now() + h * 3600_000);
const ev = (patch: Record<string, unknown>) => ({
  subAccountId: "sa1", agencyId: "ag1", title: "Consult", status: "scheduled", contactId: null,
  territoryId: "global", startAt: inHours(2), endAt: inHours(3), ...patch,
});
const run = async (name: string, args: Record<string, unknown>) =>
  (await getCapability(name)!.execute(ctx as never, args)).resultText;

beforeEach(() => {
  seedTenants({});
});

describe("find_events", () => {
  it("leaves imported Google events out", async () => {
    mem.seed("events/b1", ev({ title: "Real booking" }));
    mem.seed("events/g1", ev({ title: "Private dentist", source: "google" }));
    const text = await run("find_events", { range: "all-upcoming" });
    expect(text).toContain("Real booking");
    expect(text).not.toContain("Private dentist");
  });

  it("60 earlier imported events don't push a real one out of the 50 read", async () => {
    for (let i = 0; i < 60; i++) mem.seed(`events/g${i}`, ev({ title: `Imported ${i}`, source: "google", startAt: inHours(1 + i / 100) }));
    mem.seed("events/late", ev({ title: "Later booking", startAt: inHours(5) }));
    const text = await run("find_events", { range: "all-upcoming" });
    expect(text).toContain("Later booking");
    expect(text).not.toContain("Imported");
  });
});

describe("find_awaiting_payment_bookings", () => {
  it("leaves an imported Google event out", async () => {
    mem.seed("events/b1", ev({ title: "Held booking", status: "awaiting_payment" }));
    mem.seed("events/g1", ev({ title: "Private dentist", status: "awaiting_payment", source: "google" }));
    const text = await run("find_awaiting_payment_bookings", {});
    expect(text).toContain("Held booking");
    expect(text).not.toContain("Private dentist");
  });
});

describe("tools that act on an event by id", () => {
  beforeEach(() => {
    mem.seed("events/g1", ev({ title: "Private dentist", source: "google", status: "awaiting_payment", startAt: inHours(-2) }));
  });
  const refusal = /comes from Google Calendar/;

  it("set_event_status refuses it at approval, preview and execute", async () => {
    const cap = getCapability("set_event_status")!;
    const args = { eventId: "g1", status: "cancelled" };
    await expect(cap.approvalTarget!(ctx as never, args)).rejects.toThrow(refusal);
    await expect(cap.preview!(ctx as never, args)).rejects.toThrow(refusal);
    await expect(cap.execute(ctx as never, { eventId: "g1", status: "completed" })).rejects.toThrow(refusal);
    expect(mem.read("events/g1")?.status).toBe("awaiting_payment");
  });

  it("mark_booking_paid refuses it", async () => {
    const cap = getCapability("mark_booking_paid")!;
    await expect(cap.approvalTarget!(ctx as never, { eventId: "g1" })).rejects.toThrow(refusal);
    await expect(cap.preview!(ctx as never, { eventId: "g1" })).rejects.toThrow(refusal);
  });
});
