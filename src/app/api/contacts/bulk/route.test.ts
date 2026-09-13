import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-handler tests for POST /api/contacts/bulk. Firestore is a recording
 * fake: the assertions are about WHICH writes the handler issues — nothing at
 * all when one id is foreign, one batch per 499 otherwise — and about the
 * side effects the single-contact paths already have (the tag trigger, the
 * shared delete helper), which a bulk path must not skip.
 */

interface ContactRow {
  subAccountId: string;
  agencyId: string;
  tags?: string[];
  territoryId?: string | null;
  mode?: string;
}

const fake = vi.hoisted(() => ({
  contacts: new Map<string, ContactRow>(),
  batches: [] as { updates: [string, Record<string, unknown>][] }[],
  members: new Set<string>(),
  access: {
    uid: "u1",
    subAccountId: "sa",
    subAccountRole: "admin" as "admin" | "collaborator" | "agencyOwner",
  },
  scope: { enforce: false, ids: null as string[] | null },
  trigger: vi.fn(),
  deleteContact: vi.fn(),
  webhook: vi.fn(),
  limit: { ok: true, retryAfterSec: 0 },
  mirror: vi.fn(),
}));
vi.mock("@/lib/server/conversation-mirror", () => ({
  mirrorContactAssignee: fake.mirror,
}));
vi.mock("@/lib/contacts/bulk-rate-limit", () => ({
  checkBulkRateLimit: () => fake.limit,
}));

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) => ({
      path,
      get: async () => {
        const [col, id] = path.split("/");
        if (col === "contacts") {
          const row = fake.contacts.get(id);
          return { exists: !!row, id, data: () => row };
        }
        // subAccounts/sa/subAccountMembers/{uid}
        const uid = path.split("/")[3];
        return {
          exists: fake.members.has(uid),
          data: () => ({ status: "active" }),
        };
      },
    }),
    getAll: async (...refs: { path: string }[]) =>
      refs.map((r) => {
        const id = r.path.split("/")[1];
        const row = fake.contacts.get(id);
        return { exists: !!row, id, ref: r, data: () => row };
      }),
    batch: () => {
      const b = { updates: [] as [string, Record<string, unknown>][] };
      fake.batches.push(b);
      return {
        update: (ref: { path: string }, data: Record<string, unknown>) => {
          b.updates.push([ref.path, data]);
        },
        commit: async () => {},
      };
    },
  }),
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async () => fake.access,
}));
vi.mock("@/lib/auth/territory-filter", () => ({
  loadEffectiveTerritoryScope: async () => fake.scope,
}));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: fake.trigger,
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({
  emitWebhookEvent: fake.webhook,
}));
vi.mock("@/lib/api/serializers/contacts", () => ({
  serializeContactForApi: (id: string) => ({ id }),
}));
vi.mock("@/lib/server/contact-delete", () => ({
  deleteContactServerSide: fake.deleteContact,
}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "ts" },
}));

import { POST } from "./route";

function post(body: unknown) {
  return POST(
    new Request("http://x/api/contacts/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function seed(id: string, over: Partial<ContactRow> = {}) {
  fake.contacts.set(id, {
    subAccountId: "sa",
    agencyId: "ag",
    tags: [],
    territoryId: "global",
    mode: "live",
    ...over,
  });
}

beforeEach(() => {
  fake.contacts.clear();
  fake.batches.length = 0;
  fake.members.clear();
  fake.access = { uid: "u1", subAccountId: "sa", subAccountRole: "admin" };
  fake.scope = { enforce: false, ids: null };
  fake.trigger.mockReset();
  fake.deleteContact.mockReset().mockResolvedValue({ status: "deleted" });
  fake.webhook.mockReset();
  fake.limit = { ok: true, retryAfterSec: 0 };
  fake.mirror.mockReset().mockResolvedValue(1);
});

it("returns 429 with Retry-After once the per-user limiter trips, writing nothing", async () => {
  seed("a");
  fake.limit = { ok: false, retryAfterSec: 42 };
  const res = await post({
    subAccountId: "sa",
    ids: ["a"],
    action: { type: "add_tag", tag: "vip" },
  });
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBe("42");
  expect(fake.batches).toHaveLength(0);
});

describe("tenancy", () => {
  it("refuses the whole batch when one id belongs to another sub-account, writing nothing", async () => {
    seed("a");
    seed("b", { subAccountId: "other" });
    const res = await post({
      subAccountId: "sa",
      ids: ["a", "b"],
      action: { type: "add_tag", tag: "vip" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ foreignIds: ["b"] });
    expect(fake.batches).toHaveLength(0);
    expect(fake.trigger).not.toHaveBeenCalled();
  });

  it("treats an unknown id as foreign", async () => {
    seed("a");
    const res = await post({
      subAccountId: "sa",
      ids: ["a", "ghost"],
      action: { type: "add_tag", tag: "vip" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ foreignIds: ["ghost"] });
    expect(fake.batches).toHaveLength(0);
  });

  it("refuses contacts outside a scoped collaborator's territories", async () => {
    fake.access = { uid: "u1", subAccountId: "sa", subAccountRole: "collaborator" };
    fake.scope = { enforce: true, ids: ["global", "north"] };
    seed("a", { territoryId: "north" });
    seed("b", { territoryId: "south" });
    const res = await post({
      subAccountId: "sa",
      ids: ["a", "b"],
      action: { type: "add_tag", tag: "vip" },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ deniedIds: ["b"] });
    expect(fake.batches).toHaveLength(0);
  });
});

describe("add_tag / remove_tag", () => {
  it("adds the tag once and fires contact.tag.added only for contacts that gained it", async () => {
    seed("a", { tags: ["lead"] });
    seed("b", { tags: ["vip"] });
    const res = await post({
      subAccountId: "sa",
      ids: ["a", "b"],
      action: { type: "add_tag", tag: "vip" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, updated: 2 });
    const updates = fake.batches.flatMap((b) => b.updates);
    expect(updates).toEqual([
      ["contacts/a", { tags: ["lead", "vip"], updatedAt: "ts" }],
      ["contacts/b", { tags: ["vip"], updatedAt: "ts" }],
    ]);
    expect(fake.trigger).toHaveBeenCalledTimes(1);
    expect(fake.trigger).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "contact.tag.added",
        contactId: "a",
        subAccountId: "sa",
        context: { addedTags: ["vip"] },
      }),
    );
  });

  it("removes the tag and fires nothing", async () => {
    seed("a", { tags: ["lead", "vip"] });
    const res = await post({
      subAccountId: "sa",
      ids: ["a"],
      action: { type: "remove_tag", tag: "vip" },
    });
    expect(res.status).toBe(200);
    expect(fake.batches[0].updates).toEqual([
      ["contacts/a", { tags: ["lead"], updatedAt: "ts" }],
    ]);
    expect(fake.trigger).not.toHaveBeenCalled();
  });

  it("chunks writes at 499 per batch", async () => {
    const ids = Array.from({ length: 600 }, (_, i) => `c${i}`);
    for (const id of ids) seed(id);
    const res = await post({
      subAccountId: "sa",
      ids,
      action: { type: "add_tag", tag: "vip" },
    });
    expect(res.status).toBe(200);
    expect(fake.batches.map((b) => b.updates.length)).toEqual([499, 101]);
  });
});

describe("assign", () => {
  it("assigns to a member and refuses a uid outside the roster", async () => {
    seed("a");
    fake.members.add("m1");
    const ok = await post({
      subAccountId: "sa",
      ids: ["a"],
      action: { type: "assign", assignedToUid: "m1" },
    });
    expect(ok.status).toBe(200);
    expect(fake.batches[0].updates).toEqual([
      ["contacts/a", { assignedToUid: "m1", updatedAt: "ts" }],
    ]);

    fake.batches.length = 0;
    const bad = await post({
      subAccountId: "sa",
      ids: ["a"],
      action: { type: "assign", assignedToUid: "stranger" },
    });
    expect(bad.status).toBe(400);
    expect(fake.batches).toHaveLength(0);
  });

  it("mirrors the new owner onto every selected contact's conversation (SP2 T1)", async () => {
    seed("a");
    seed("b");
    fake.members.add("m1");
    await post({
      subAccountId: "sa",
      ids: ["a", "b"],
      action: { type: "assign", assignedToUid: "m1" },
    });
    expect(fake.mirror.mock.calls.map((c) => c[0])).toEqual([
      { contactId: "a", subAccountId: "sa" },
      { contactId: "b", subAccountId: "sa" },
    ]);
    fake.mirror.mockClear();
    await post({
      subAccountId: "sa",
      ids: ["a"],
      action: { type: "assign", assignedToUid: null },
    });
    expect(fake.mirror).toHaveBeenCalledWith({
      contactId: "a",
      subAccountId: "sa",
    });
  });

  it("does not mirror on a tag action or a refused assign", async () => {
    seed("a");
    await post({
      subAccountId: "sa",
      ids: ["a"],
      action: { type: "add_tag", tag: "vip" },
    });
    await post({
      subAccountId: "sa",
      ids: ["a"],
      action: { type: "assign", assignedToUid: "stranger" },
    });
    expect(fake.mirror).not.toHaveBeenCalled();
  });

  it("null unassigns", async () => {
    seed("a");
    const res = await post({
      subAccountId: "sa",
      ids: ["a"],
      action: { type: "assign", assignedToUid: null },
    });
    expect(res.status).toBe(200);
    expect(fake.batches[0].updates).toEqual([
      ["contacts/a", { assignedToUid: null, updatedAt: "ts" }],
    ]);
  });
});

describe("delete", () => {
  it("is admin-only", async () => {
    fake.access = { uid: "u1", subAccountId: "sa", subAccountRole: "collaborator" };
    seed("a");
    const res = await post({
      subAccountId: "sa",
      ids: ["a"],
      action: { type: "delete" },
    });
    expect(res.status).toBe(403);
    expect(fake.deleteContact).not.toHaveBeenCalled();
  });

  it("deletes through the shared single-contact helper and reports blocked ones", async () => {
    seed("a");
    seed("b");
    fake.deleteContact.mockImplementation(async ({ contactId }: { contactId: string }) =>
      contactId === "b"
        ? { status: "blocked", blockers: [{ type: "deals", label: "deal", count: 1 }] }
        : { status: "deleted" },
    );
    const res = await post({
      subAccountId: "sa",
      ids: ["a", "b"],
      action: { type: "delete" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      deleted: 1,
      blocked: [{ id: "b", blockers: [{ type: "deals", count: 1 }] }],
    });
    expect(fake.deleteContact).toHaveBeenCalledTimes(2);
    // No batch writes: a delete never bypasses the helper's cascade.
    expect(fake.batches).toHaveLength(0);
  });
});

it("rejects a malformed body", async () => {
  expect((await post({ subAccountId: "sa", ids: [], action: { type: "add_tag", tag: "x" } })).status).toBe(400);
  expect((await post({ subAccountId: "sa", ids: ["a"], action: { type: "add_tag", tag: "" } })).status).toBe(400);
  expect((await post({ subAccountId: "sa", ids: ["a"], action: { type: "nope" } })).status).toBe(400);
});
