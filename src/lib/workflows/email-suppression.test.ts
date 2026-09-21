import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Workflow `send_email` and `notify` against the sub-account's suppression
 * list: real engine → real sendEmail → real lookup, over an in-memory
 * Firestore. A suppressed recipient is logged `skipped:suppressed` in the run
 * history — never "ok", and never an error that reads as a provider failure.
 */

const s = () => import("@/test/email-suppression-seam");
vi.mock("@/lib/firebase/admin", async () => (await s()).seamMocks.admin());
vi.mock("@/lib/comms/smtp", async (orig) => (await s()).seamMocks.smtp(orig));
vi.mock("@/lib/server/email-conversations", async () => (await s()).seamMocks.conversations());
vi.mock("@/lib/server/usage-meter", async (orig) => (await s()).seamMocks.usage(orig));
vi.mock("@/lib/automations/unsubscribe-token", () => ({
  buildUnsubscribeUrl: (id: string) => `https://app.test/u/${id}`,
}));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => false,
  publishCallback: async () => undefined,
}));

const { SA, AGENCY, mem, resetSeam, suppress, wireRecipients } = await s();
const { runStep } = await import("./engine");

function seedRun(node: { type: string; config: Record<string, unknown> }) {
  mem.seed("workflows/wf1", {
    name: "Fixture flow",
    status: "active",
    createdByUid: "u1",
    agencyId: AGENCY,
    subAccountId: SA,
    nodes: { n1: { id: "n1", ...node, next: null } },
  });
  mem.seed("workflowRuns/run1", {
    workflowId: "wf1",
    contactId: "c1",
    subAccountId: SA,
    agencyId: AGENCY,
    status: "running",
    history: [],
    context: {},
  });
}

async function stepLog(): Promise<string> {
  await runStep("run1", "n1");
  const run = mem.read("workflowRuns/run1") as { history: { nodeId: string; result: string }[] };
  const entry = run.history.find((h) => h.nodeId === "n1");
  if (!entry) throw new Error("step recorded no history entry");
  return entry.result;
}

beforeEach(() => {
  resetSeam();
  mem.seed(`agencies/${AGENCY}`, {});
  mem.seed("contacts/c1", {
    name: "Thandi",
    email: "thandi@example.co.za",
    phone: "",
    emailOptedOut: false,
    agencyId: AGENCY,
    subAccountId: SA,
  });
});

describe("workflow send_email", () => {
  beforeEach(() => seedRun({ type: "send_email", config: { subject: "Hi", body: "Hello" } }));

  it("sends to an address that is not suppressed", async () => {
    expect(await stepLog()).toBe("ok");
    expect(wireRecipients()).toEqual(["thandi@example.co.za"]);
  });

  it("logs a suppressed contact as skipped:suppressed and sends nothing", async () => {
    suppress("Thandi@Example.co.za");
    expect(await stepLog()).toBe("skipped:suppressed");
    expect(wireRecipients()).toEqual([]);
  });
});

describe("workflow notify", () => {
  beforeEach(() =>
    seedRun({ type: "notify", config: { recipient: "custom", to: "ops@tenant.test", subject: "Lead", body: "x" } })
  );

  it("sends to an address that is not suppressed", async () => {
    expect(await stepLog()).toBe("ok");
    expect(wireRecipients()).toEqual(["ops@tenant.test"]);
  });

  it("logs a suppressed staff address as skipped:suppressed and sends nothing", async () => {
    suppress("ops@tenant.test");
    expect(await stepLog()).toBe("skipped:suppressed");
    expect(wireRecipients()).toEqual([]);
  });
});
