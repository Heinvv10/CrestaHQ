import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryFirestore } from "@/test/memory-firestore";
import { mintApiKey } from "@/lib/api/keys";

/**
 * POST /api/v1/contacts/upsert — the phone is the identity.
 *
 * Driven through the REAL withApiAuth (key lookup, agency gate, idempotency
 * cache), the real upsert service and the real workflow engine, over an
 * in-memory Firestore that honours query filters and serializes
 * transactions. Stubbed: outbound webhooks and QStash only.
 */

const mem = createMemoryFirestore();
const published: unknown[] = [];
const triggers: Promise<unknown>[] = [];

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: async (input: unknown) => {
    published.push(input);
    return { messageId: `msg_${published.length}` };
  },
}));
vi.mock("@/lib/workflows/engine", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/workflows/engine")>();
  return {
    ...real,
    fireWorkflowTrigger: (input: Parameters<typeof real.fireWorkflowTrigger>[0]) => {
      const p = real.fireWorkflowTrigger(input);
      triggers.push(p);
      return p;
    },
  };
});

const { POST } = await import("./route");

const TAG = "velocity-review-ready";
const E164 = "+27821234567";
let liveKey = "";
let testKey = "";

function seedKey(id: string, mode: "live" | "test"): string {
  const k = mintApiKey(mode);
  mem.seed(`subAccounts/sa1/apiKeys/${id}`, {
    subAccountId: "sa1", agencyId: "ag1", name: id, mode, prefix: k.prefix,
    hashedSecret: k.hashedSecret, scopes: ["admin"], revokedAt: null,
  });
  return k.rawKey;
}

/** The fields the assertions read; a given response carries one side. */
interface UpsertJson {
  created: boolean;
  contact: { id: string };
  error: { code: string };
}

async function upsert(
  body: Record<string, unknown>,
  opts: { key?: string; idem?: string } = {},
): Promise<{ status: number; json: UpsertJson }> {
  const headers: Record<string, string> = { authorization: `Bearer ${opts.key ?? liveKey}` };
  if (opts.idem) headers["idempotency-key"] = opts.idem;
  const res = await POST(
    new Request("https://app.test/api/v1/contacts/upsert", {
      method: "POST", headers, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
  await Promise.all(triggers);
  return { status: res.status, json: (await res.json()) as UpsertJson };
}

const contacts = () => mem.list("contacts");
const runs = () => mem.list("workflowRuns");
const bucket = () =>
  mem.list("subAccounts/sa1/apiEnrolments").reduce((n, d) => n + ((d.count as number) ?? 0), 0);

const CANDIDATE = {
  phone: E164,
  name: "Thandi Mokoena",
  custom_fields: { install_address: "14 Acacia Street, Lawley", dr_number: "DR1734562" },
  tags_add: [TAG],
};

beforeEach(() => {
  mem.clear();
  published.length = 0;
  triggers.length = 0;
  mem.seed("subAccounts/sa1", {
    name: "Velocity", agencyId: "ag1", apiAccessEnabledByAgency: true, defaultPhoneCountry: "ZA",
  });
  for (const key of ["install_address", "dr_number", "keep"]) {
    mem.seed(`subAccounts/sa1/customFields/cf_${key}`, {
      entity: "contact", key, label: key, type: "text", options: [], required: false, order: 0,
    });
  }
  mem.seed("workflows/wf_review", {
    subAccountId: "sa1", agencyId: "ag1", status: "active", startNodeId: "n1",
    nodes: { n1: { id: "n1", type: "add_tag", config: { tag: "x" } } },
    trigger: { type: "contact.tag.added", filters: { all: [{ field: "tags", op: "has_tag", value: TAG }] } },
    stats: { enrolled: 0 },
  });
  liveKey = seedKey("key_live", "live");
  testKey = seedKey("key_test", "test");
});

describe("upsert by phone", () => {
  it("the same phone twice is one contact and one enrolment", async () => {
    const first = await upsert(CANDIDATE);
    const second = await upsert(CANDIDATE);

    expect([first.status, second.status]).toEqual([201, 200]);
    expect([first.json.created, second.json.created]).toEqual([true, false]);
    expect(second.json.contact.id).toBe(first.json.contact.id);
    expect(contacts()).toHaveLength(1);
    expect(runs()).toHaveLength(1);
    expect(bucket()).toBe(1);
  });

  it("two concurrent calls, in two phone formats, create one contact", async () => {
    // A test key on purpose: live mode first runs enrolment-cap
    // transactions that contend on one bucket and stagger the two calls, so
    // their upsert transactions would never overlap. Here the two paths are
    // identical step for step, so both read before either commits — the
    // race the phone lock exists to settle.
    await Promise.all([
      upsert(CANDIDATE, { key: testKey }),
      upsert({ ...CANDIDATE, phone: "082 123 4567" }, { key: testKey }),
    ]);

    expect(contacts()).toHaveLength(1);
    expect(contacts()[0].phone).toBe(E164);
  });

  it("replays an Idempotency-Key without re-executing, and refuses the key on another body", async () => {
    const first = await upsert(CANDIDATE, { idem: "dr1734562-27821234567" });
    const replay = await upsert(CANDIDATE, { idem: "dr1734562-27821234567" });
    const reused = await upsert({ ...CANDIDATE, name: "Someone Else" }, { idem: "dr1734562-27821234567" });

    expect(replay.status).toBe(201);
    expect(replay.json).toEqual(first.json);
    expect(reused.status).toBe(409);
    expect(reused.json.error.code).toBe("idempotency_collision");
    expect(contacts()).toHaveLength(1);
    expect(contacts()[0].name).toBe("Thandi Mokoena");
    expect(runs()).toHaveLength(1);
  });

  it("updates a contact created elsewhere, against its current tags and fields", async () => {
    mem.seed("contacts/c_existing", {
      subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Thandi", phone: E164,
      tags: ["customer", "old", "vip"], customFields: { install_address: "old", keep: "x" },
    });

    const res = await upsert({ ...CANDIDATE, tags_remove: ["old"] });

    expect(res.status).toBe(200);
    const [c] = contacts();
    expect(c.id).toBe("c_existing");
    expect(c.tags).toEqual(["customer", "vip", TAG]);
    expect(c.customFields).toEqual({
      install_address: "14 Acacia Street, Lawley", keep: "x", dr_number: "DR1734562",
    });
    expect(runs()).toHaveLength(1);
    // The lock doc is touched, never kept: no phone outlives its contact.
    expect(mem.list("subAccounts/sa1/contactPhoneIndex")).toHaveLength(0);
  });

  it("does not fire for a tag another writer adds right after this request commits", async () => {
    mem.seed("contacts/c_existing", {
      subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Thandi", phone: E164, tags: [],
    });
    const commit = mem.db.runTransaction;
    vi.spyOn(mem.db, "runTransaction").mockImplementation(async (fn) => {
      const result = await commit(fn);
      // Right after the upsert's own commit (the enrolment-cap transactions
      // pass through untouched), an operator tags the contact.
      const c = mem.read("contacts/c_existing");
      if (c?.customFields && !(c.tags as string[]).includes(TAG)) {
        mem.seed("contacts/c_existing", { ...c, tags: [TAG] });
      }
      return result;
    });

    const res = await upsert({ phone: E164, custom_fields: { dr_number: "DR1" } });

    expect(res.status).toBe(200);
    expect(mem.read("contacts/c_existing")?.tags).toEqual([TAG]);
    expect(runs()).toHaveLength(0);
    expect(bucket()).toBe(0);
    vi.restoreAllMocks();
  });

  it("clears a custom field sent as null and keeps the ones not sent", async () => {
    await upsert(CANDIDATE);
    await upsert({ phone: E164, custom_fields: { dr_number: null, keep: "y" } });

    expect(contacts()[0].customFields).toEqual({
      install_address: "14 Acacia Street, Lawley", keep: "y",
    });
  });
});

describe("refusals write nothing and enrol nobody", () => {
  it("refuses when two contacts already share the phone", async () => {
    for (const id of ["c_a", "c_b"]) {
      mem.seed(`contacts/${id}`, {
        subAccountId: "sa1", agencyId: "ag1", mode: "live", name: id, phone: E164, tags: [],
      });
    }

    const res = await upsert(CANDIDATE);

    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("ambiguous_phone");
    expect(contacts().map((c) => c.tags)).toEqual([[], []]);
    expect(runs()).toHaveLength(0);
    expect(bucket()).toBe(0);
  });

  it("still refuses once another path has duplicated a contact it created", async () => {
    const first = await upsert(CANDIDATE);
    mem.seed("contacts/c_dashboard_dup", {
      subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Dup", phone: E164, tags: [],
    });

    const res = await upsert({ phone: E164, custom_fields: { dr_number: "DR2" } });

    expect(res.status).toBe(409);
    expect(mem.read(`contacts/${first.json.contact.id}`)?.customFields).toMatchObject({
      dr_number: "DR1734562",
    });
  });

  it.each([
    ["an unknown custom field key", { ...CANDIDATE, custom_fields: { dr_nuber: "DR1" } }],
    ["a whole-array `tags` replace", { ...CANDIDATE, tags: [TAG] }],
    ["an invalid phone", { ...CANDIDATE, phone: "not a phone" }],
    ["a pipeline_stage it would otherwise drop", { ...CANDIDATE, pipeline_stage: "won" }],
    ["a create with no name", { ...CANDIDATE, name: undefined }],
  ])("refuses %s", async (_label, body) => {
    const res = await upsert(body);

    expect(res.status).toBe(400);
    expect(contacts()).toHaveLength(0);
    expect(runs()).toHaveLength(0);
    expect(bucket()).toBe(0);
  });
});

it("a test-mode key writes a test contact and enrols nobody", async () => {
  const res = await upsert(CANDIDATE, { key: testKey });

  expect(res.status).toBe(201);
  expect(contacts()[0].mode).toBe("test");
  expect(runs()).toHaveLength(0);
});
