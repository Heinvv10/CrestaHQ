import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryFirestore } from "@/test/memory-firestore";
import { ADDABLE_TYPES } from "@/lib/workflows/catalog";

/**
 * PATCH /api/sub-accounts/:id/workflows/:workflowId — the builder's Save.
 *
 * The route validated step types against its own copy of the list, which
 * went stale when `send_whatsapp` was added: every workflow containing a
 * "Send WhatsApp" step failed to save with "Invalid nodes". Driven through
 * the real route and the real update service; only tenancy auth is stubbed.
 */

const mem = createMemoryFirestore();

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async () => ({ uid: "u1" }),
}));

const { PATCH } = await import("./route");

const save = (body: Record<string, unknown>) =>
  PATCH(
    new Request("https://app.test/api/sub-accounts/sa1/workflows/wf1", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "sa1", workflowId: "wf1" }) },
  );

beforeEach(() => {
  mem.clear();
  mem.seed("workflows/wf1", {
    subAccountId: "sa1", agencyId: "ag1", name: "Review ask", status: "draft",
    startNodeId: null, nodes: {}, trigger: { type: "contact.created", filters: { all: [] } },
  });
});

describe("saving a workflow's steps", () => {
  it("saves a Send WhatsApp step", async () => {
    const res = await save({
      startNodeId: "n1",
      nodes: {
        n1: { id: "n1", type: "send_whatsapp", config: { body: "Thanks {{contact.firstName}}!" }, next: null },
      },
    });

    expect(res.status).toBe(200);
    expect(mem.read("workflows/wf1")?.nodes).toMatchObject({
      n1: { type: "send_whatsapp", config: { body: "Thanks {{contact.firstName}}!" } },
    });
  });

  it("saves one step of every type the builder offers", async () => {
    const nodes = Object.fromEntries(
      ADDABLE_TYPES.map((type, i) => [`n${i}`, { id: `n${i}`, type, config: {}, next: null }]),
    );

    const res = await save({ nodes });

    expect(res.status).toBe(200);
    expect(Object.keys((mem.read("workflows/wf1")?.nodes as object) ?? {})).toHaveLength(
      ADDABLE_TYPES.length,
    );
  });

  it("still refuses a step type the builder does not offer, and writes nothing", async () => {
    const res = await save({
      nodes: { n1: { id: "n1", type: "launch_rocket", config: {}, next: null } },
    });

    expect(res.status).toBe(400);
    expect(mem.read("workflows/wf1")?.nodes).toEqual({});
  });
});

describe("moving a workflow between folders", () => {
  beforeEach(() => {
    mem.seed("subAccounts/sa1/workflowFolders/mine", { name: "Mine", subAccountId: "sa1" });
    mem.seed("subAccounts/sa2/workflowFolders/theirs", { name: "Theirs", subAccountId: "sa2" });
  });

  it("files it into a folder of this sub-account, and back to Unfiled", async () => {
    expect((await save({ folderId: "mine" })).status).toBe(200);
    expect(mem.read("workflows/wf1")?.folderId).toBe("mine");

    expect((await save({ folderId: null })).status).toBe(200);
    expect(mem.read("workflows/wf1")?.folderId).toBeNull();
  });

  it("refuses another sub-account's folder with 404 and writes nothing", async () => {
    const res = await save({ folderId: "theirs", name: "Renamed" });

    expect(res.status).toBe(404);
    expect(mem.read("workflows/wf1")).not.toHaveProperty("folderId");
    expect(mem.read("workflows/wf1")?.name).toBe("Review ask");
  });

  it("refuses a path-shaped or non-string folder id with 404", async () => {
    for (const folderId of ["../../subAccounts/sa2/workflowFolders/theirs", 42, ""]) {
      expect((await save({ folderId })).status).toBe(404);
    }
    expect(mem.read("workflows/wf1")).not.toHaveProperty("folderId");
  });
});
