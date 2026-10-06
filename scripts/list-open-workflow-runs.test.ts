import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { AT_MOST_ONCE_NODES } from "@/lib/workflows/engine";
import { listOpenRuns, MESSAGING_STEP_TYPES, parseArgs, toOpenRun } from "./list-open-workflow-runs";

const ts = (iso: string) => ({ toDate: () => new Date(iso) });
const run = (over: Record<string, unknown> = {}) => ({
  subAccountId: "sa1",
  workflowId: "wf1",
  contactId: "c1",
  status: "waiting",
  currentNodeId: "n2",
  history: [],
  context: {},
  enrolledAt: ts("2026-10-01T10:00:00Z"),
  ...over,
});

describe("toOpenRun", () => {
  it("keeps running and waiting runs, drops finished ones", () => {
    expect(toOpenRun("r", run({ status: "running" }), "sa1")?.status).toBe("running");
    expect(toOpenRun("r", run({ status: "waiting" }), "sa1")?.status).toBe("waiting");
    for (const status of ["completed", "failed", "exited"]) {
      expect(toOpenRun("r", run({ status }), "sa1")).toBeNull();
    }
  });

  it("drops a run from another sub-account", () => {
    expect(toOpenRun("r", run({ subAccountId: "other" }), "sa1")).toBeNull();
  });

  it("marks a run messaged unless every messaging step was skipped or deferred", () => {
    const messaged = (type: string, result: string) => toOpenRun("r", run({ history: [{ type, result }] }), "sa1")?.messaged;
    expect(messaged("wait", "ok")).toBe(false);
    expect(messaged("whatsapp_template", "skipped:opt_out")).toBe(false);
    expect(messaged("send_whatsapp", "deferred:quiet_hours_until_2026-10-07T06:00:00.000Z")).toBe(false);
    expect(messaged("whatsapp_template", "ok")).toBe(true);
    // The engine logs these after the provider accepted, or may have accepted, the send.
    expect(messaged("send_whatsapp", "sent:message_record_failed")).toBe(true);
    expect(messaged("send_sms", "error:timeout")).toBe(true);
  });

  it("treats a step claim as possibly sent", () => {
    expect(toOpenRun("r", run({ stepClaim: { nodeId: "n1", state: "sending", at: null } }), "sa1")?.messaged).toBe(true);
    expect(toOpenRun("r", run({ stepClaim: null }), "sa1")?.messaged).toBe(false);
  });

  it("reports the wait deadline, enrolment time and test flag", () => {
    const r = toOpenRun("r1", run({ waiting: { nodeId: "n2", kind: "reply", since: null, until: ts("2026-10-03T10:00:00Z") }, context: { test: true } }), "sa1");
    expect(r).toEqual({
      runId: "r1", workflowId: "wf1", contactId: "c1", status: "waiting", test: true,
      currentNodeId: "n2", waitingUntil: "2026-10-03T10:00:00.000Z", enrolledAt: "2026-10-01T10:00:00.000Z", messaged: false,
    });
  });
});

describe("MESSAGING_STEP_TYPES", () => {
  it("matches the engine's at-most-once messaging steps", () => {
    expect([...MESSAGING_STEP_TYPES].sort()).toEqual([...AT_MOST_ONCE_NODES].sort());
  });
});

describe("listOpenRuns", () => {
  it("queries each workflow and returns its open runs, oldest first", async () => {
    const docs: Record<string, [string, Record<string, unknown>][]> = {
      wf1: [
        ["b", run({ enrolledAt: ts("2026-10-02T00:00:00Z") })],
        ["done", run({ status: "completed" })],
      ],
      wf2: [["a", run({ workflowId: "wf2", enrolledAt: ts("2026-09-30T00:00:00Z") })]],
    };
    const asked: string[] = [];
    const db = {
      collection: (name: string) => {
        expect(name).toBe("workflowRuns");
        return {
          where: (field: string, op: string, value: string) => {
            expect([field, op]).toEqual(["workflowId", "=="]);
            asked.push(value);
            return { get: async () => ({ docs: (docs[value] ?? []).map(([id, d]) => ({ id, data: () => d })) }) };
          },
        };
      },
    } as unknown as Firestore;
    const runs = await listOpenRuns(db, { projectId: "p", subAccountId: "sa1", workflowIds: ["wf1", "wf2"] });
    expect(asked).toEqual(["wf1", "wf2"]);
    expect(runs.map((r) => r.runId)).toEqual(["a", "b"]);
  });
});

describe("parseArgs", () => {
  it("takes one project and sub-account and repeated workflows", () => {
    expect(parseArgs(["--project", "p", "--sub-account", "s", "--workflow", "w1", "--workflow", "w2"])).toEqual({
      projectId: "p", subAccountId: "s", workflowIds: ["w1", "w2"],
    });
  });

  it("refuses missing or repeated required flags", () => {
    expect(() => parseArgs(["--sub-account", "s", "--workflow", "w"])).toThrow(/--project/);
    expect(() => parseArgs(["--project", "p", "--workflow", "w"])).toThrow(/--sub-account/);
    expect(() => parseArgs(["--project", "p", "--sub-account", "s"])).toThrow(/--workflow/);
    expect(() => parseArgs(["--project", "p", "--project", "q", "--sub-account", "s", "--workflow", "w"])).toThrow(/--project/);
  });
});
