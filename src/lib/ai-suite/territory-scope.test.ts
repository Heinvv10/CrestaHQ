import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * AI Suite capabilities apply the same territory rule as firestore.rules'
 * canSeeScopedDoc: a territory-scoped collaborator sees Global + their
 * assigned territories (never an untagged doc); admins / agency owners and
 * scoping-off sub-accounts see everything. Real execute() over an in-memory
 * Firestore; only webhooks + workflows are stubbed.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: async () => ({ enrolled: [], skipped: [], reason: null }),
}));

const { getCapability, CapabilityUserError } = await import("./capabilities");

const base = { email: "a@example.com", displayName: "A", agencyId: "ag1", subAccountId: "sa1" };
const rep = { ...base, uid: "u_rep", subAccountRole: "collaborator" };
const admin = { ...base, uid: "u_admin", subAccountRole: "admin" };
const owner = { ...base, uid: "u_owner", subAccountRole: "agencyOwner" };

const TERRITORIES: Record<string, string | undefined> = {
  n: "north", // assigned to the rep
  g: "global", // shared pool
  s: "south", // someone else's
  x: undefined, // untagged
};
const future = (h: number) => new Date(Date.now() + h * 3_600_000);
const tenant = { subAccountId: "sa1", agencyId: "ag1" };
const tag = (territoryId: string | undefined) => (territoryId ? { territoryId } : {});

function seedRecords() {
  for (const [k, t] of Object.entries(TERRITORIES)) {
    mem.seed(`contacts/c_${k}`, { ...tenant, ...tag(t), name: `Ann ${k}`, email: `${k}@x.io` });
    mem.seed(`deals/d_${k}`, { ...tenant, ...tag(t), title: `Deal ${k}`, stageId: "new", value: 10, currency: "USD", contactId: `c_${k}` });
    mem.seed(`tasks/t_${k}`, { ...tenant, ...tag(t), title: `Task ${k}`, completed: false, contactId: `c_${k}` });
    mem.seed(`events/e_${k}`, { ...tenant, ...tag(t), title: `Event ${k}`, startAt: future(24), status: "scheduled", contactId: `c_${k}` });
    mem.seed(`quotes/q_${k}`, { ...tenant, ...tag(t) });
  }
}

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", territoryScopingEnabled: true, timezone: "UTC" });
  mem.seed("subAccounts/sa1/subAccountMembers/u_rep", { role: "collaborator", assignedTerritoryIds: ["north"] });
  seedRecords();
});

const run = (name: string, ctx: typeof rep, args: Record<string, unknown> = {}) =>
  getCapability(name)!.execute(ctx, args).then((r) => r.resultText);

const VISIBLE = ["n", "g"];
const HIDDEN = ["s", "x"];

function expectOnly(text: string, label: string, keys: string[]) {
  for (const k of Object.keys(TERRITORIES)) {
    if (keys.includes(k)) expect(text).toContain(`${label} ${k}`);
    else expect(text).not.toContain(`${label} ${k}`);
  }
}

describe("lookups: a scoped collaborator sees only their territories", () => {
  it.each([
    ["find_contacts", "Ann", { query: "ann" }],
    ["find_deals", "Deal", { query: "deal", stage: "" }],
    ["find_tasks", "Task", { filter: "all-open" }],
    ["find_events", "Event", { range: "all-upcoming" }],
  ])("%s", async (name, label, args) => {
    expectOnly(await run(name, rep, args), label, VISIBLE);
    expectOnly(await run(name, admin, args), label, [...VISIBLE, ...HIDDEN]);
    expectOnly(await run(name, owner, args), label, [...VISIBLE, ...HIDDEN]);
  });

  it("a sub-account with scoping off is unrestricted for collaborators", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", territoryScopingEnabled: false, timezone: "UTC" });
    expectOnly(await run("find_contacts", rep, { query: "ann" }), "Ann", [...VISIBLE, ...HIDDEN]);
  });

  it("find_contacts filters before its 500 cap — out-of-territory rows can't crowd out the rep's", async () => {
    mem.clear();
    mem.seed("subAccounts/sa1", { agencyId: "ag1", territoryScopingEnabled: true });
    mem.seed("subAccounts/sa1/subAccountMembers/u_rep", { role: "collaborator", assignedTerritoryIds: ["north"] });
    for (let i = 0; i < 520; i++) mem.seed(`contacts/s${i}`, { ...tenant, territoryId: "south", name: `Zed ${i}` });
    mem.seed("contacts/mine", { ...tenant, territoryId: "north", name: "Zed mine" });
    const text = await run("find_contacts", rep, { query: "zed" });
    expect(text).toContain("Zed mine");
    expect(text).not.toMatch(/Zed \d/);
  });

  it("find_events filters before its 50 cap — earlier out-of-territory events can't crowd out the rep's", async () => {
    for (let i = 0; i < 80; i++) mem.seed(`events/s${i}`, { ...tenant, territoryId: "south", title: `Early ${i}`, startAt: future(1) });
    const text = await run("find_events", rep, { range: "all-upcoming" });
    expect(text).toContain("Event n");
    expect(text).toContain("Event g");
    expect(text).not.toContain("Early");
  });

  it("a rep with 30 assigned territories (31 with Global) still sees the last one", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `t${i}`);
    mem.seed("subAccounts/sa1/subAccountMembers/u_rep", { role: "collaborator", assignedTerritoryIds: ids });
    mem.seed("contacts/c_last", { ...tenant, territoryId: "t29", name: "Ann last" });
    const text = await run("find_contacts", rep, { query: "ann" });
    expect(text).toContain("Ann last");
    expect(text).toContain("Ann g");
    expect(await run("workspace_stats", rep)).toContain("- Contacts: 2");
  });

  it("contact names on task/event lines never resolve an out-of-territory contact", async () => {
    mem.seed("tasks/t_n", { ...tenant, territoryId: "north", title: "Task n", completed: false, contactId: "c_s" });
    const text = await run("find_tasks", rep, { filter: "all-open" });
    expect(text).toContain("Task n");
    expect(text).not.toContain("Ann s");
  });

  it("workspace_stats counts only visible records", async () => {
    const scoped = await run("workspace_stats", rep);
    expect(scoped).toContain("- Contacts: 2");
    expect(scoped).toContain("Pipeline (2 deals");
    expect(scoped).toContain("- Open tasks: 2");
    expect(scoped).toContain("- Upcoming calendar events: 2");
    expect(scoped).toContain("- Quotes: 2");
    const all = await run("workspace_stats", admin);
    expect(all).toContain("- Contacts: 4");
    expect(all).toContain("Pipeline (4 deals");
    expect(all).toContain("- Open tasks: 4");
    expect(all).toContain("- Upcoming calendar events: 4");
    expect(all).toContain("- Quotes: 4");
  });
});

describe("actions: a scoped collaborator can't act on out-of-territory records", () => {
  const actions: Array<[string, (k: string) => Record<string, unknown>]> = [
    ["create_deal", (k) => ({ title: "New", value: 1, currency: "USD", contactId: `c_${k}`, contactName: "Ann", stage: "new" })],
    ["move_deal_stage", (k) => ({ dealId: `d_${k}`, dealTitle: "", stage: "contacted", lostReason: "" })],
    ["create_task", (k) => ({ title: "Call", notes: "", dueAt: "", contactId: `c_${k}`, contactName: "Ann" })],
    ["complete_task", (k) => ({ taskId: `t_${k}`, taskTitle: "" })],
    ["create_event", (k) => ({ title: "Meet", date: "2030-01-01", time: "10:00", durationMinutes: 30, contactId: `c_${k}`, contactName: "Ann", location: "", notes: "" })],
  ];

  describe.each(actions)("%s", (name, argsFor) => {
    it.each(HIDDEN)("refuses the rep on territory %s, and writes nothing", async (k) => {
      const before = JSON.stringify(mem.list("deals")) + JSON.stringify(mem.list("tasks")) + JSON.stringify(mem.list("events"));
      const err = await getCapability(name)!.execute(rep, argsFor(k)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CapabilityUserError);
      expect((err as Error).message).toMatch(/isn't in one of your assigned territories/);
      const after = JSON.stringify(mem.list("deals")) + JSON.stringify(mem.list("tasks")) + JSON.stringify(mem.list("events"));
      expect(after).toBe(before);
    });

    it.each(VISIBLE)("allows the rep on territory %s", async (k) => {
      await expect(getCapability(name)!.execute(rep, argsFor(k))).resolves.toBeTruthy();
    });

    it("allows an admin on any territory", async () => {
      for (const k of HIDDEN) await expect(getCapability(name)!.execute(admin, argsFor(k))).resolves.toBeTruthy();
    });
  });

  it("create_deal stamps the contact's territory on the new deal", async () => {
    const res = await getCapability("create_deal")!.execute(rep, {
      title: "New", value: 1, currency: "USD", contactId: "c_n", contactName: "Ann", stage: "new",
    });
    expect(mem.list("deals").find((d) => d.title === "New")).toMatchObject({ territoryId: "north" });
    expect(res.ref?.kind).toBe("deal");
  });
});
