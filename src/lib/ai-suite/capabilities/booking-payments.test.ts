import { beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { ask, doConfirm, lookupResult, mem, role, seedTenants } from "@/test/chat-route-harness";

/**
 * find_awaiting_payment_bookings and the chat side of mark_booking_paid
 * (N2a) through the real chat and confirm routes. The read lists only this
 * workspace's held bookings, by the caller's territories. mark_booking_paid
 * emails the customer, so chat never offers it, the confirm route refuses
 * it, and execute refuses without an approval whatever called it.
 * (Its agent approval path: route.booking-paid.test.ts.)
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/chat-route-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/chat-route-harness")).tenancyMock());
vi.mock("@/lib/ai-suite/model", async () => (await import("@/test/chat-route-harness")).modelMock());
vi.mock("@/lib/ai-suite/usage", () => ({ recordAiSuiteUsage: async () => undefined }));
vi.mock("@/lib/ai-suite/audit", () => ({ recordAiSuiteAction: async () => undefined }));
const sendEmail = vi.hoisted(() => vi.fn(async () => ({ id: "e1" })));
vi.mock("@/lib/comms/resend", async (orig) => ({ ...((await orig()) as object), sendEmail }));

const { availableOn, getCapability, toolsForLevel } = await import("@/lib/ai-suite/capabilities");

const at = (h: number) => Timestamp.fromMillis(Date.UTC(2030, 0, 10, h));
const held = (patch: Record<string, unknown>) => ({
  subAccountId: "sa1", agencyId: "ag1", title: "Consult", status: "awaiting_payment", contactId: "c1",
  bookingPageSlug: "bp1", territoryId: "global", startAt: at(9), endAt: at(10), ...patch,
});

beforeEach(() => {
  seedTenants({ territoryScopingEnabled: true });
  sendEmail.mockClear();
  mem.seed("subAccounts/sa1/subAccountMembers/u1", { role: "collaborator", assignedTerritoryIds: ["north"] });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Ann", email: "ann@x.io", territoryId: "global" });
  mem.seed("events/ev_later", held({ title: "Later", startAt: at(14), endAt: at(15) }));
  mem.seed("events/ev_soon", held({ title: "Soon" }));
  mem.seed("events/ev_north", held({ title: "North", territoryId: "north" }));
  mem.seed("events/ev_south", held({ title: "South", territoryId: "south" }));
  mem.seed("events/ev_done", held({ title: "Done", status: "scheduled" }));
  mem.seed("events/ev_theirs", held({ title: "Theirs", subAccountId: "sa2" }));
});

describe("find_awaiting_payment_bookings", () => {
  it("an admin sees every held booking in this workspace, soonest first, with ids; none of another's, none confirmed", async () => {
    await ask("find_awaiting_payment_bookings", {});
    const text = lookupResult();
    expect(text).toContain("Bookings awaiting payment (4, times in UTC):");
    expect(text.indexOf("- Soon")).toBeLessThan(text.indexOf("- Later"));
    expect(text).toContain("- Soon — Thu, Jan 10, 9:00 AM, Ann, page: bp1, id: ev_soon");
    expect(text).not.toContain("Theirs");
    expect(text).not.toContain("Done");
  });

  it("a territory-scoped collaborator sees only Global and their own territories", async () => {
    role.current = "collaborator";
    await ask("find_awaiting_payment_bookings", {});
    const text = lookupResult();
    expect(text).toContain("North");
    expect(text).toContain("Soon");
    expect(text).not.toContain("South");
  });

  it("more than 20 held: the soonest 20 by start, whatever the ids, and the answer is marked truncated", async () => {
    // Ids sort opposite to start times, so an unordered read would keep the latest.
    for (let i = 0; i < 25; i++) mem.seed(`events/ev_z${String(99 - i).padStart(2, "0")}`, held({ title: `Held ${i}`, startAt: at(i), endAt: at(i + 1) }));
    const ctx = { uid: "u1", email: "", displayName: "", agencyId: "ag1", subAccountId: "sa1", subAccountRole: "admin" };
    const out = await getCapability("find_awaiting_payment_bookings")!.execute(ctx, {});
    expect(out.truncated).toBe(true);
    expect(out.resultText).toContain("Bookings awaiting payment (the soonest 20, times in UTC):");
    expect(out.resultText).toContain("- Held 0 —");
    expect(out.resultText).not.toContain("- Held 19 —");
    expect(out.resultText).toContain("(More are waiting — see the Calendar.)");
  });

  it("nothing held: says so", async () => {
    for (const id of ["ev_later", "ev_soon", "ev_north", "ev_south"]) mem.seed(`events/${id}`, held({ status: "scheduled" }));
    await ask("find_awaiting_payment_bookings", {});
    expect(lookupResult()).toBe("No bookings are waiting on a deposit.");
  });
});

describe("mark_booking_paid in chat", () => {
  it("is not offered to anyone in chat, and the confirm route refuses it by name", async () => {
    for (const subAccountRole of ["admin", "collaborator"]) {
      const tools = toolsForLevel("sub-account", { agencyRoleIsOwner: false, subAccountRole }).map((t) => t.function.name);
      expect(tools).not.toContain("mark_booking_paid");
      expect(tools).toContain("find_awaiting_payment_bookings");
    }
    expect(availableOn(getCapability("mark_booking_paid")!, "chat")).toBe(false);
    const res = await doConfirm("mark_booking_paid", { eventId: "ev_soon" });
    expect(res.status).toBe(400);
    expect(mem.read("events/ev_soon")!.status).toBe("awaiting_payment");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("the model naming it gets no card", async () => {
    const body = await (await ask("mark_booking_paid", { eventId: "ev_soon" })).json();
    expect(body.type).not.toBe("proposal");
    expect(mem.read("events/ev_soon")!.status).toBe("awaiting_payment");
  });

  it("execute refuses without an approval (and its chat refusal says where to do it)", async () => {
    const cap = getCapability("mark_booking_paid")!;
    const ctx = { uid: "u1", email: "", displayName: "", agencyId: "ag1", subAccountId: "sa1", subAccountRole: "admin" };
    const refusal = "Marking a booking paid emails the customer their confirmation, so I can't do it from here. Open the booking on the Calendar and click Mark paid.";
    expect(cap.chatRefusal!({ eventId: "ev_soon" }, ctx)).toBe(refusal);
    await expect(cap.execute(ctx, { eventId: "ev_soon" })).rejects.toThrow(refusal);
    expect(mem.read("events/ev_soon")!.status).toBe("awaiting_payment");
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
