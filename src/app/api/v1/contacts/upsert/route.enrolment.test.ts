import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryFirestore } from "@/test/memory-firestore";
import { mintApiKey } from "@/lib/api/keys";

/**
 * The upsert's `enrolment` block — FibreFlow's one call per install answers
 * "did the trigger tag start the workflow?" in its own response.
 *
 * Deliberately NOT wrapping the engine to await its promises: the route has
 * to have finished the enrolment before it responds, so every assertion
 * reads the response (and the store) the moment the request returns. Real
 * withApiAuth, real service, real engine; stubbed: webhooks and QStash.
 */

const mem = createMemoryFirestore();
let publishOk = true;

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: async () => (publishOk ? { messageId: "msg_1" } : null),
}));

const { POST } = await import("./route");

const TAG = "velocity-review-ready";
const E164 = "+27821234567";
let liveKey = "";
let testKey = "";

interface Enrolment {
  status: string;
  reason: string | null;
  runs: Array<{ workflow_id: string; run_id: string; status: string }>;
  skipped: Array<{ workflow_id: string; reason: string }>;
}
interface Json {
  enrolment: Enrolment | null;
  error: { code: string };
}

async function upsert(
  body: Record<string, unknown>,
  opts: { key?: string; idem?: string } = {},
): Promise<{ status: number; json: Json }> {
  const headers: Record<string, string> = { authorization: `Bearer ${opts.key ?? liveKey}` };
  if (opts.idem) headers["idempotency-key"] = opts.idem;
  const res = await POST(
    new Request("https://app.test/api/v1/contacts/upsert", {
      method: "POST", headers, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
  return { status: res.status, json: (await res.json()) as Json };
}

function seedKey(id: string, mode: "live" | "test"): string {
  const k = mintApiKey(mode);
  mem.seed(`subAccounts/sa1/apiKeys/${id}`, {
    subAccountId: "sa1", agencyId: "ag1", name: id, mode, prefix: k.prefix,
    hashedSecret: k.hashedSecret, scopes: ["admin"], revokedAt: null,
  });
  return k.rawKey;
}

function seedReviewWorkflow(over: Record<string, unknown> = {}) {
  mem.seed("workflows/wf_review", {
    subAccountId: "sa1", agencyId: "ag1", status: "active", startNodeId: "n1",
    nodes: { n1: { id: "n1", type: "add_tag", config: { tag: "x" } } },
    trigger: { type: "contact.tag.added", tag: TAG, filters: { all: [] } },
    stats: { enrolled: 0 },
    ...over,
  });
}

const CANDIDATE = {
  phone: E164,
  name: "Thandi Mokoena",
  custom_fields: { install_address: "14 Acacia Street, Lawley", dr_number: "DR1734562" },
  tags_add: [TAG],
};
const runs = () => mem.list("workflowRuns");

beforeEach(() => {
  mem.clear();
  publishOk = true;
  mem.seed("subAccounts/sa1", {
    name: "Velocity", agencyId: "ag1", apiAccessEnabledByAgency: true, defaultPhoneCountry: "ZA",
  });
  for (const key of ["install_address", "dr_number"]) {
    mem.seed(`subAccounts/sa1/customFields/cf_${key}`, {
      entity: "contact", key, label: key, type: "text", options: [], required: false, order: 0,
    });
  }
  seedReviewWorkflow();
  liveKey = seedKey("key_live", "live");
  testKey = seedKey("key_test", "test");
});

describe("enrolment is answered in the response", () => {
  it("returns the run id the trigger tag started", async () => {
    const { status, json } = await upsert(CANDIDATE);

    expect(status).toBe(201);
    const [run] = runs();
    expect(json.enrolment).toEqual({
      status: "enrolled",
      reason: null,
      runs: [{ workflow_id: "wf_review", run_id: run.id, status: "running" }],
      skipped: [],
    });
    expect(run).toMatchObject({ workflowId: "wf_review", status: "running" });
  });

  it("says the tag was already there on a re-run, and starts nothing", async () => {
    await upsert(CANDIDATE);
    const again = await upsert(CANDIDATE);

    expect(again.json.enrolment).toMatchObject({ status: "not_enrolled", reason: "tag_already_present" });
    expect(runs()).toHaveLength(1);
  });

  it("replays the original run id for a repeated Idempotency-Key", async () => {
    const first = await upsert(CANDIDATE, { idem: "DR1734562:27821234567" });
    const replay = await upsert(CANDIDATE, { idem: "DR1734562:27821234567" });

    expect(replay.json.enrolment).toEqual(first.json.enrolment);
    expect(runs()).toHaveLength(1);
  });

  it("is null when no tag was asked for", async () => {
    const { json } = await upsert({ ...CANDIDATE, tags_add: undefined });
    expect(json.enrolment).toBeNull();
  });
});

describe("trigger.tag narrowing", () => {
  it("does not start a workflow narrowed to a different tag", async () => {
    seedReviewWorkflow({ trigger: { type: "contact.tag.added", tag: "other", filters: { all: [] } } });

    const { json } = await upsert(CANDIDATE);

    expect(json.enrolment).toMatchObject({
      status: "not_enrolled",
      reason: "no_matching_workflow",
      skipped: [{ workflow_id: "wf_review", reason: "trigger_mismatch" }],
    });
    expect(runs()).toHaveLength(0);
  });

  it("does not restart the review when a later, unrelated tag is added", async () => {
    await upsert(CANDIDATE);
    await upsert({ phone: E164, tags_add: ["newsletter"] });

    expect(runs()).toHaveLength(1);
  });
});

describe("the reason it did not enrol", () => {
  it("filters_not_met", async () => {
    seedReviewWorkflow({
      trigger: {
        type: "contact.tag.added", tag: TAG,
        filters: { all: [{ field: "customFields.dr_number", op: "is_set" }] },
      },
    });
    const { json } = await upsert({ ...CANDIDATE, custom_fields: {} });
    expect(json.enrolment?.reason).toBe("filters_not_met");
  });

  it("reentry_blocked", async () => {
    seedReviewWorkflow({ reentry: "once_ever" });
    await upsert(CANDIDATE);
    await upsert({ phone: E164, tags_remove: [TAG] });
    const { json } = await upsert({ phone: E164, tags_add: [TAG] });
    expect(json.enrolment?.reason).toBe("reentry_blocked");
    expect(runs()).toHaveLength(1);
  });

  it("run_failed, naming the run that could not be scheduled", async () => {
    publishOk = false;
    const { json } = await upsert(CANDIDATE);
    expect(json.enrolment).toMatchObject({
      status: "not_enrolled",
      reason: "run_failed",
      runs: [{ workflow_id: "wf_review", status: "failed" }],
    });
  });

  it("automations_paused", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), automationsPaused: true });
    const { json } = await upsert(CANDIDATE);
    expect(json.enrolment?.reason).toBe("automations_paused");
  });

  it("test_mode, for a test key", async () => {
    const { json } = await upsert(CANDIDATE, { key: testKey });
    expect(json.enrolment).toMatchObject({ status: "not_enrolled", reason: "test_mode" });
    expect(runs()).toHaveLength(0);
  });
});

it("refuses the whole call when the agency has API access switched off", async () => {
  mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), apiAccessEnabledByAgency: false });

  const { status, json } = await upsert(CANDIDATE);

  expect(status).toBe(403);
  expect(json.error.code).toBe("api_access_disabled");
  expect(mem.list("contacts")).toHaveLength(0);
  expect(runs()).toHaveLength(0);
});
