import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The human / route path keeps its fire-and-forget trigger: with a trigger
 * that never settles, the service still resolves. Only an agent write
 * (actor set) awaits the trigger, because it owes the agent its held
 * enrolments.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
const fireWorkflowTrigger = vi.fn(() => new Promise(() => {}));
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger }));

const { createContactServerSide } = await import("./contacts-service");
const { createDealServerSide, updateDealServerSide } = await import("./deals-service");

const actor = { keyId: "key1", keyPrefix: "abcd1234", keyLevel: "sub-account" as const, capability: "fixture" };
const contactInput = {
  subAccountId: "sa1", agencyId: "ag1", createdByUid: "u1", mode: "live" as const,
  name: "Ann", email: "", phone: "", company: "", address: "", source: "test", tags: [],
};
const dealInput = {
  subAccountId: "sa1", agencyId: "ag1", createdByUid: "u1", mode: "live" as const, source: "ai" as const,
  title: "Fibre", value: 1, currency: "ZAR", contactId: "c1", stageId: "new" as const, priority: "medium" as const,
};
/** Resolves "pending" if `p` has not settled after a few ticks. */
const settles = async (p: Promise<unknown>) => {
  const pending = Symbol("pending");
  let r: unknown = pending;
  void p.then((v) => (r = v));
  for (let i = 0; i < 50 && r === pending; i++) await new Promise((x) => setImmediate(x));
  return r !== pending;
};

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Ann" });
  fireWorkflowTrigger.mockClear();
});

describe("route path: fire-and-forget (does not await the trigger)", () => {
  it("createContactServerSide resolves while its trigger hangs", async () => {
    expect(await settles(createContactServerSide(contactInput))).toBe(true);
    expect(fireWorkflowTrigger).toHaveBeenCalledTimes(1);
  });

  it("createDealServerSide and a stage move resolve while their triggers hang", async () => {
    const created = createDealServerSide(dealInput);
    expect(await settles(created)).toBe(true);
    const { id } = await created;
    expect(await settles(updateDealServerSide({ dealId: id, userId: "u1", source: "ai", patch: { stageId: "contacted" } }))).toBe(true);
    expect(fireWorkflowTrigger).toHaveBeenCalledTimes(2);
  });
});

describe("agent path: awaits the trigger", () => {
  it("createContactServerSide with an actor waits for its trigger", async () => {
    expect(await settles(createContactServerSide({ ...contactInput, actor }))).toBe(false);
  });

  it("createDealServerSide with an actor waits for its trigger", async () => {
    expect(await settles(createDealServerSide({ ...dealInput, actor }))).toBe(false);
  });
});
