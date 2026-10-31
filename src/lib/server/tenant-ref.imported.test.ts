import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Nothing links to an event imported from a member's Google Calendar — it is
 * their own calendar, not a CRM record. refInSubAccount refuses it for every
 * caller: the dashboard's POST /api/tasks (no mode) and the agent's
 * update_task, through the real route / capability and task service. The
 * sub-account's own manual event still links (control).
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async () => ({ uid: "u_member", subAccountId: "sa1", subAccountRole: "admin" }),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));

const { POST } = await import("@/app/api/tasks/route");
const { getCapability } = await import("@/lib/ai-suite/capabilities");
const { refInSubAccount } = await import("./tenant-ref");

const own = { subAccountId: "sa1", agencyId: "ag1" };
beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("events/manual", { ...own, title: "Visit" });
  mem.seed("events/g1", { ...own, source: "google", importOwnerUid: "u_member", title: "Dentist" });
  mem.seed("tasks/t1", { ...own, title: "Call", contactId: null, dealId: null, eventId: null, completed: false });
});

describe("refInSubAccount and imported Google events", () => {
  it("refuses one for every caller, with or without a mode", async () => {
    expect(await refInSubAccount("events", "g1", "sa1")).toBe(false);
    expect(await refInSubAccount("events", "g1", "sa1", "live")).toBe(false);
    expect(await refInSubAccount("events", "manual", "sa1")).toBe(true);
  });

  const createTask = (eventId: string) =>
    POST(new Request("http://x/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subAccountId: "sa1", title: "Prep", eventId }),
    }));

  it("dashboard POST /api/tasks: 404, nothing written", async () => {
    expect((await createTask("g1")).status).toBe(404);
    expect(mem.list("tasks").map((t) => t.id)).toEqual(["t1"]);
    expect((await createTask("manual")).status).toBe(201);
  });

  it("agent update_task: refused, the task keeps its link", async () => {
    const ctx = { uid: "u_member", email: "", displayName: "", agencyId: "ag1", subAccountId: "sa1", subAccountRole: "admin" };
    const update = getCapability("update_task")!;
    await expect(update.execute(ctx as never, { taskId: "t1", eventId: "g1" })).rejects.toThrow(
      "That appointment isn't in this workspace.",
    );
    expect(mem.read("tasks/t1")?.eventId).toBeNull();
    await update.execute(ctx as never, { taskId: "t1", eventId: "manual" });
    expect(mem.read("tasks/t1")?.eventId).toBe("manual");
  });
});
