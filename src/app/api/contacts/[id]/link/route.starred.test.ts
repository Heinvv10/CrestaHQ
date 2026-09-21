import { beforeEach, expect, it, vi } from "vitest";

/**
 * POST /api/contacts/[id]/link merges the Meta stub's conversation index doc
 * into the survivor's. A star on either side must survive (SP2 I6) — the
 * merge patch is hand-built, so a new conversation field is dropped unless
 * it is carried explicitly.
 */
const fake = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  sets: [] as { path: string; data: Record<string, unknown> }[],
}));

vi.mock("@/lib/firebase/admin", () => {
  const empty = { docs: [] };
  function coll(path: string): Record<string, unknown> {
    const q: Record<string, unknown> = {
      where: () => q,
      get: async () => empty,
      doc: (id: string) => docRef(`${path}/${id}`),
    };
    return q;
  }
  function docRef(path: string) {
    return {
      path,
      get: async () => ({
        exists: fake.docs.has(path),
        data: () => fake.docs.get(path),
      }),
      set: async (data: Record<string, unknown>) => {
        fake.sets.push({ path, data });
      },
      update: async () => undefined,
      delete: async () => undefined,
      collection: (name: string) => coll(`${path}/${name}`),
    };
  }
  return {
    getAdminDb: () => ({
      doc: docRef,
      collection: coll,
      collectionGroup: coll,
      batch: () => ({ set() {}, update() {}, commit: async () => undefined }),
      recursiveDelete: async () => undefined,
    }),
  };
});
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: async () => ({ uid: "u1" }),
}));
vi.mock("@/lib/server/contacts-service", () => ({
  emitContactDeleted: vi.fn(),
}));

import { POST } from "./route";

const TENANT = { subAccountId: "sa", agencyId: "ag" };

function seed(
  stubConv: Record<string, unknown>,
  targetConv: Record<string, unknown>
) {
  fake.docs.set("contacts/stub", {
    ...TENANT,
    name: "Stub",
    metaUserId: "psid-1",
  });
  fake.docs.set("contacts/target", { ...TENANT, name: "Target", phone: "+27" });
  fake.docs.set("conversations/stub", {
    ...TENANT,
    channelsSeen: ["messenger"],
    ...stubConv,
  });
  fake.docs.set("conversations/target", {
    ...TENANT,
    channelsSeen: ["sms"],
    ...targetConv,
  });
}

async function link() {
  const res = await POST(
    new Request("http://x/api/contacts/stub/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetContactId: "target" }),
    }),
    { params: Promise.resolve({ id: "stub" }) }
  );
  expect(res.status).toBe(200);
  const write = fake.sets.find((s) => s.path === "conversations/target");
  expect(write, "survivor conversation was not written").toBeTruthy();
  return write!.data;
}

beforeEach(() => {
  fake.docs.clear();
  fake.sets.length = 0;
});

it("carries the stub's star onto the survivor", async () => {
  seed({ starred: true }, {});
  expect((await link()).starred).toBe(true);
});

it("writes no star when neither side had one", async () => {
  seed({ starred: false }, {});
  expect(await link()).not.toHaveProperty("starred");
});

// SP2 T1/I9 + territory: when the survivor has no conversation, it ADOPTS the
// stub's. Everything the conversation copies off its contact must then come
// from the survivor, not the stub.
it("an adopted conversation takes the survivor's owner, email and territory", async () => {
  seed({ assigneeUid: "stub-owner", contactEmail: "stub@x.co", territoryId: "stub-territory" }, {});
  fake.docs.delete("conversations/target");
  fake.docs.set("contacts/target", {
    ...TENANT,
    name: "Target",
    phone: "+27",
    email: "target@x.co",
    assignedToUid: "target-owner",
    territoryId: "north",
  });
  expect(await link()).toMatchObject({
    contactId: "target",
    assigneeUid: "target-owner",
    contactEmail: "target@x.co",
    territoryId: "north",
  });
});

it("an adopted conversation of an unassigned, territory-less survivor is cleared, not inherited", async () => {
  seed({ assigneeUid: "stub-owner", contactEmail: "stub@x.co", territoryId: "stub-territory" }, {});
  fake.docs.delete("conversations/target");
  expect(await link()).toMatchObject({
    assigneeUid: null,
    contactEmail: null,
    territoryId: null,
  });
});
