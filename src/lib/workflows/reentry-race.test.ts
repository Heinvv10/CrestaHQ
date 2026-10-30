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
/** Every target handed to tx.get — a query here locks an index range shared
 *  by every contact of the workflow on the real server SDK. */
let txReads: unknown[] = [];
type TxFn = Parameters<typeof mem.db.runTransaction>[0];
/** One-shot concurrent writers, injected after the pre-transaction query:
 *  `beforeTx` runs before the transaction starts, `afterTxRead` after its
 *  first read (the lock) and before its commit. */
type Hook = (() => Promise<unknown>) | null;
let beforeTx: Hook = null;
let afterTxRead: Hook = null;
const db = {
  ...mem.db,
  runTransaction: async (fn: TxFn) => {
    if (txDown) throw new Error("10 ABORTED: contention");
    const pre = beforeTx;
    beforeTx = null;
    await pre?.();
    return mem.db.runTransaction((tx) =>
      fn({
        ...tx,
        get: async (target) => {
          txReads.push(target);
          const r = await tx.get(target);
          const mid = afterTxRead;
          afterTxRead = null;
          await mid?.();
          return r;
        },
      })
    );
  },
};
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: async () => ({ messageId: "q1" }),
}));

const { fireWorkflowTrigger, enrollForTest } = await import("./engine");

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
  txReads = [];
  beforeTx = null;
  afterTxRead = null;
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

describe("re-entry lock doc", () => {
  const LOCK = "workflowEnrolmentLocks/wf1_c1";
  const lock = (lastRunId: string) =>
    mem.seed(LOCK, { workflowId: "wf1", contactId: "c1", lastRunId });
  const run = (id: string, status: string) =>
    mem.seed(`workflowRuns/${id}`, { workflowId: "wf1", contactId: "c1", status });

  it("the transaction reads document refs only, never a query", async () => {
    seed("unless_active");
    lock("r0");
    run("r0", "completed");
    await fire();
    expect(txReads.length).toBeGreaterThan(0);
    for (const target of txReads) {
      expect(typeof (target as { path?: unknown }).path).toBe("string");
    }
  });

  it("once_ever: an existing lock blocks, even with no run found", async () => {
    seed("once_ever");
    lock("gone");
    const outcome = await fire();
    expect(outcome.skipped).toEqual([{ workflowId: "wf1", reason: "reentry_blocked" }]);
    expect(mem.list("workflowRuns")).toHaveLength(0);
  });

  it("once_ever: a legacy run with no lock still blocks", async () => {
    seed("once_ever");
    run("legacy", "completed");
    const outcome = await fire();
    expect(outcome.skipped).toEqual([{ workflowId: "wf1", reason: "reentry_blocked" }]);
    expect(mem.list("workflowRuns")).toHaveLength(1);
  });

  it("unless_active: blocks while lock.lastRunId is waiting, allows once it completed", async () => {
    seed("unless_active");
    lock("r0");
    run("r0", "waiting");
    expect((await fire()).skipped).toEqual([{ workflowId: "wf1", reason: "reentry_blocked" }]);
    await mem.db.doc("workflowRuns/r0").update({ status: "completed" });
    expect((await fire()).enrolled).toHaveLength(1);
    expect(mem.list("workflowRuns")).toHaveLength(2);
  });

  it("creates the run and the lock when neither exists", async () => {
    seed("once_ever");
    const outcome = await fire();
    expect(outcome.enrolled).toHaveLength(1);
    const [created] = mem.list("workflowRuns");
    expect(mem.read(LOCK)).toMatchObject({
      workflowId: "wf1", contactId: "c1", subAccountId: "sa1", agencyId: "ag1",
      lastRunId: created.id,
    });
  });
});

describe("a run created without the re-entry check, racing one with it", () => {
  // A test enrolment skips the policy (every_time path) but must still write
  // the lock, or unless_active cannot see its live run: the pre-transaction
  // query already ran, and the transaction reads only the lock.
  const testEnrol = () =>
    enrollForTest({ subAccountId: "sa1", workflowId: "wf1", contactId: "c1" });

  it("created between the pre-query and the transaction: unless_active blocks", async () => {
    seed("unless_active");
    beforeTx = testEnrol;
    const outcome = await fire();
    expect(outcome.skipped).toEqual([{ workflowId: "wf1", reason: "reentry_blocked" }]);
    expect(mem.list("workflowRuns")).toHaveLength(1);
  });

  it("created after the transaction read the lock: the commit conflicts and re-runs", async () => {
    seed("unless_active");
    afterTxRead = testEnrol;
    const outcome = await fire();
    expect(outcome.skipped).toEqual([{ workflowId: "wf1", reason: "reentry_blocked" }]);
    expect(mem.list("workflowRuns")).toHaveLength(1);
  });

  it("an every_time enrolment writes the lock with its run", async () => {
    seed("every_time");
    await fire();
    const [run] = mem.list("workflowRuns");
    expect(mem.read("workflowEnrolmentLocks/wf1_c1")).toMatchObject({
      workflowId: "wf1", contactId: "c1", subAccountId: "sa1", agencyId: "ag1",
      lastRunId: run.id,
    });
  });
});

describe("keyed enrolment (enrolmentKey)", () => {
  const fireKeyed = (enrolmentKey: string) =>
    fireWorkflowTrigger({
      subAccountId: "sa1", agencyId: "ag1", type: "message.received",
      contactId: "c1", context: { channel: "whatsapp" }, enrolmentKey,
    });
  const completeAll = async () => {
    for (const r of mem.list("workflowRuns")) {
      await mem.db.doc(`workflowRuns/${r.id}`).update({ status: "completed" });
    }
  };

  it.each(["every_time", "unless_active", "once_ever"])(
    "%s: a repeat of the key is refused after the first run completed",
    async (policy) => {
      seed(policy);
      expect((await fireKeyed("report:r1")).enrolled).toHaveLength(1);
      await completeAll();
      const again = await fireKeyed("report:r1");
      expect(again.skipped).toEqual([{ workflowId: "wf1", reason: "reentry_blocked" }]);
      const [run] = mem.list("workflowRuns");
      expect(mem.list("workflowRuns")).toHaveLength(1);
      expect(mem.read("workflowEnrolmentKeys/wf1_c1_report:r1")).toMatchObject({
        workflowId: "wf1", contactId: "c1", subAccountId: "sa1", agencyId: "ag1",
        enrolmentKey: "report:r1", runId: run.id,
      });
    },
  );

  it("every_time: another key still enrols, and so does an unkeyed trigger", async () => {
    seed("every_time");
    await fireKeyed("report:r1");
    expect((await fireKeyed("report:r2")).enrolled).toHaveLength(1);
    expect((await fire()).enrolled).toHaveLength(1);
    expect(mem.list("workflowRuns")).toHaveLength(3);
  });

  it("every_time: simultaneous fires of one key enrol once", async () => {
    seed("every_time");
    await Promise.all([fireKeyed("report:r1"), fireKeyed("report:r1"), fireKeyed("report:r1")]);
    expect(mem.list("workflowRuns")).toHaveLength(1);
  });

  it("a failed keyed transaction enrols nobody", async () => {
    seed("every_time");
    txDown = true;
    expect((await fireKeyed("report:r1")).skipped).toEqual([{ workflowId: "wf1", reason: "reentry_check_failed" }]);
    expect(mem.list("workflowRuns")).toHaveLength(0);
  });
});
