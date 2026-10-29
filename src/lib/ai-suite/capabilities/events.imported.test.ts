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

// `failImportedCount`: a `source ==` query's count fails, as it does in
// production until its composite index has built.
const flags = vi.hoisted(() => ({ failImportedCount: false }));
vi.mock("@/lib/firebase/admin", async () => {
  const harness = await import("@/test/chat-route-harness");
  type Q = { where: (f: string, op: string, v: unknown) => Q } & Record<string | symbol, unknown>;
  const pass = <T extends object>(t: T, k: string | symbol) => {
    const v = (t as Record<string | symbol, unknown>)[k];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
  };
  const wrap = (q: Q): Q =>
    new Proxy(q, {
      get: (t, k) =>
        k === "where"
          ? (f: string, op: string, v: unknown) =>
              f === "source" && flags.failImportedCount
                ? { count: () => ({ get: () => Promise.reject(new Error("9 FAILED_PRECONDITION: The query requires an index.")) }) }
                : wrap(t.where(f, op, v))
          : pass(t, k),
    });
  const db = harness.mem.db as unknown as { collection: (p: string) => Q };
  return {
    ...harness.adminMock(),
    getAdminDb: () =>
      new Proxy(db, { get: (t, k) => (k === "collection" ? (p: string) => wrap(t.collection(p)) : pass(t, k)) }),
  };
});
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

  it("mark_booking_paid refuses it at approval, preview and an approved execute", async () => {
    const cap = getCapability("mark_booking_paid")!;
    await expect(cap.approvalTarget!(ctx as never, { eventId: "g1" })).rejects.toThrow(refusal);
    await expect(cap.preview!(ctx as never, { eventId: "g1" })).rejects.toThrow(refusal);
    // Approved, with the pin a booking with these fields would carry: only the
    // imported refusal can stop it.
    const approved = {
      ...ctx,
      approved: { pinned: { eventId: "g1", contactId: null, emailTo: null, reminders: [], workflows: [] } },
    };
    await expect(cap.execute(approved as never, { eventId: "g1" })).rejects.toThrow(refusal);
    expect(mem.read("events/g1")?.status).toBe("awaiting_payment");
  });
});

describe("record counts", () => {
  beforeEach(() => {
    mem.seed("events/b1", ev({ title: "Real booking" }));
    mem.seed("events/b2", ev({ title: "Past booking", startAt: inHours(-5), endAt: inHours(-4) }));
    mem.seed("events/g1", ev({ source: "google" }));
    mem.seed("events/g2", ev({ source: "google", startAt: inHours(-5), endAt: inHours(-4) }));
  });

  it("workspace_stats counts upcoming events without imported ones", async () => {
    expect(await run("workspace_stats", {})).toContain("- Upcoming calendar events: 1");
  });

  it("workspace_stats still answers when the imported count fails (index still building): the old count, logged", async () => {
    flags.failImportedCount = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await run("workspace_stats", {})).toContain("- Upcoming calendar events: 2");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("[workspace_stats] imported-event count failed sa=sa1: 9 FAILED_PRECONDITION"));
    } finally {
      flags.failImportedCount = false;
      warn.mockRestore();
    }
  });

  it("workspace_stats for a territory-scoped caller too", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", aiSuiteEnabledByAgency: true, timezone: "UTC", name: "W", territoryScopingEnabled: true });
    mem.seed("subAccounts/sa1/subAccountMembers/u1", { role: "collaborator", status: "active", assignedTerritoryIds: ["north"] });
    const scoped = { ...ctx, subAccountRole: "collaborator" };
    const text = (await getCapability("workspace_stats")!.execute(scoped as never, {})).resultText;
    expect(text).toContain("- Upcoming calendar events: 1");
  });

  it("sub_account_stats counts calendar events without imported ones", async () => {
    const agencyCtx = { uid: "owner1", email: "", displayName: "", agencyId: "ag1", agencyRole: "owner" };
    const text = (await getCapability("sub_account_stats")!.execute(agencyCtx as never, { subAccountId: "sa1" })).resultText;
    expect(text).toContain(" 2 calendar events");
  });
});
