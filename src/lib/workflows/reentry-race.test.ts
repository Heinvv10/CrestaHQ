import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * `unless_active` / `once_ever` must hold when the triggers arrive together:
 * three back-to-back inbound messages are three concurrent webhooks, and a
 * check-then-create enrolment lets all three through — three runs, three
 * auto-replies. The in-memory Firestore gives queries no phantom protection,
 * exactly the gap a query-only guard falls into. No step is executed: the
 * QStash publish is a stub.
 */

const mem = createMemoryFirestore();
let txDown = false;
const db = {
  ...mem.db,
  runTransaction: (fn: Parameters<typeof mem.db.runTransaction>[0]) =>
    txDown ? Promise.reject(new Error("10 ABORTED: contention")) : mem.db.runTransaction(fn),
};
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: async () => ({ messageId: "q1" }),
}));

const { fireWorkflowTrigger } = await import("./engine");

function seed(reentry: string) {
  mem.seed("subAccounts/sa1", { name: "Velocity", agencyId: "ag1" });
  mem.seed("contacts/c1", {
    subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Thandi",
    phone: "+27821234567", tags: [], customFields: {},
  });
  mem.seed("workflows/wf1", {
    name: "Auto reply", subAccountId: "sa1", agencyId: "ag1", status: "active",
    startNodeId: "n1", createdByUid: "u_owner", reentry,
    trigger: { type: "message.received", filters: { all: [] } },
    nodes: { n1: { id: "n1", type: "add_tag", config: { tag: "x" }, next: null } },
  });
}

const fire = () =>
  fireWorkflowTrigger({
    subAccountId: "sa1", agencyId: "ag1", type: "message.received",
    contactId: "c1", context: { channel: "whatsapp" },
  });

beforeEach(() => {
  mem.clear();
  txDown = false;
});

describe("re-entry under concurrent triggers", () => {
  it("unless_active: three simultaneous messages enrol the contact once", async () => {
    seed("unless_active");
    const outcomes = await Promise.all([fire(), fire(), fire()]);
    expect(mem.list("workflowRuns")).toHaveLength(1);
    expect(outcomes.flatMap((o) => o.skipped.map((s) => s.reason))).toEqual([
      "reentry_blocked",
      "reentry_blocked",
    ]);
  });

  it("unless_active: a finished run lets the next message in", async () => {
    seed("unless_active");
    await fire();
    const [run] = mem.list("workflowRuns");
    await mem.db.doc(`workflowRuns/${run.id}`).update({ status: "completed" });
    await fire();
    expect(mem.list("workflowRuns")).toHaveLength(2);
  });

  it("once_ever: simultaneous triggers enrol once", async () => {
    seed("once_ever");
    await Promise.all([fire(), fire()]);
    expect(mem.list("workflowRuns")).toHaveLength(1);
  });

  it("every_time is unaffected", async () => {
    seed("every_time");
    await Promise.all([fire(), fire()]);
    expect(mem.list("workflowRuns")).toHaveLength(2);
  });

  it("a failed re-entry transaction is reported as such and enrols nobody", async () => {
    seed("unless_active");
    txDown = true;
    const outcome = await fire();
    expect(outcome.skipped).toEqual([{ workflowId: "wf1", reason: "reentry_check_failed" }]);
    expect(mem.list("workflowRuns")).toHaveLength(0);
  });
});
