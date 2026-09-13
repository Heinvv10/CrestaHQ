import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  wheres: [] as [string, string, unknown][],
  rows: [] as { ref: { path: string } }[],
  updates: [] as [string, Record<string, unknown>][],
  committed: 0,
  fail: false,
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: (name: string) => {
      const q = {
        where: (f: string, op: string, v: unknown) => {
          m.wheres.push([f, op, v]);
          return q;
        },
        get: async () => {
          if (m.fail) throw new Error("boom");
          return { empty: m.rows.length === 0, size: m.rows.length, docs: m.rows };
        },
      };
      expect(name).toBe("conversations");
      return q;
    },
    batch: () => ({
      update: (ref: { path: string }, data: Record<string, unknown>) =>
        m.updates.push([ref.path, data]),
      commit: async () => {
        m.committed++;
      },
    }),
  }),
}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "ts" },
}));

import {
  contactMirror,
  mirrorContactAssignee,
  planConversationMirror,
} from "./conversation-mirror";

beforeEach(() => {
  m.wheres = [];
  m.rows = [];
  m.updates = [];
  m.committed = 0;
  m.fail = false;
});

describe("contactMirror", () => {
  it("maps assignedToUid → assigneeUid and email → contactEmail", () => {
    expect(
      contactMirror({ assignedToUid: "u1", email: " a@b.co " })
    ).toEqual({ assigneeUid: "u1", contactEmail: "a@b.co" });
  });
  it("reads a missing / empty owner or email as null", () => {
    expect(contactMirror({ email: "" })).toEqual({
      assigneeUid: null,
      contactEmail: null,
    });
    expect(contactMirror(null)).toEqual({
      assigneeUid: null,
      contactEmail: null,
    });
  });
});

describe("mirrorContactAssignee", () => {
  it("writes the owner onto every conversation of that contact in that sub-account", async () => {
    m.rows = [
      { ref: { path: "conversations/c1" } },
      { ref: { path: "conversations/web_s1" } },
    ];
    const n = await mirrorContactAssignee({
      contactId: "c1",
      subAccountId: "sa",
      assigneeUid: "u9",
    });
    expect(n).toBe(2);
    expect(m.wheres).toEqual([
      ["subAccountId", "==", "sa"],
      ["contactId", "==", "c1"],
    ]);
    expect(m.updates).toEqual([
      ["conversations/c1", { assigneeUid: "u9", updatedAt: "ts" }],
      ["conversations/web_s1", { assigneeUid: "u9", updatedAt: "ts" }],
    ]);
    expect(m.committed).toBe(1);
  });
  it("writes null to unassign", async () => {
    m.rows = [{ ref: { path: "conversations/c1" } }];
    await mirrorContactAssignee({
      contactId: "c1",
      subAccountId: "sa",
      assigneeUid: null,
    });
    expect(m.updates[0][1].assigneeUid).toBeNull();
  });
  it("does nothing when the contact has no conversation yet", async () => {
    expect(
      await mirrorContactAssignee({
        contactId: "c1",
        subAccountId: "sa",
        assigneeUid: "u9",
      })
    ).toBe(0);
    expect(m.committed).toBe(0);
  });
  it("logs and returns 0 instead of failing the contact save", async () => {
    m.fail = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      mirrorContactAssignee({ contactId: "c1", subAccountId: "sa", assigneeUid: "u" })
    ).resolves.toBe(0);
    expect(warn).toHaveBeenCalledWith(
      "[conversation-mirror] assignee mirror failed",
      "c1",
      expect.any(Error)
    );
    warn.mockRestore();
  });
});

describe("planConversationMirror", () => {
  const convo = {
    contactId: "c1",
    subAccountId: "sa",
    agencyId: "ag",
    assigneeUid: null,
  };
  const contact = {
    subAccountId: "sa",
    agencyId: "ag",
    assignedToUid: "u1",
    email: "x@y.co",
  };
  it("patches a pre-SP2 row that has no mirror", () => {
    expect(planConversationMirror(convo, contact)).toEqual({
      patch: { assigneeUid: "u1", contactEmail: "x@y.co" },
      orphaned: false,
    });
  });
  it("returns no patch when the mirror already matches", () => {
    expect(
      planConversationMirror(
        { ...convo, assigneeUid: "u1", contactEmail: "x@y.co" },
        contact
      )
    ).toEqual({ patch: null, orphaned: false });
  });
  it("clears a stale owner when the contact is unassigned", () => {
    expect(
      planConversationMirror(
        { ...convo, assigneeUid: "old", contactEmail: "x@y.co" },
        { ...contact, assignedToUid: null }
      ).patch
    ).toEqual({ assigneeUid: null, contactEmail: "x@y.co" });
  });
  it("never patches from a missing or foreign-tenant contact", () => {
    expect(planConversationMirror(convo, null)).toEqual({
      patch: null,
      orphaned: true,
    });
    expect(
      planConversationMirror(convo, { ...contact, subAccountId: "other" })
    ).toEqual({ patch: null, orphaned: true });
    expect(
      planConversationMirror(convo, { ...contact, agencyId: "other" })
    ).toEqual({ patch: null, orphaned: true });
  });
  it("skips an anonymous web-chat row (no contact to mirror)", () => {
    expect(
      planConversationMirror({ ...convo, contactId: null }, undefined)
    ).toEqual({ patch: null, orphaned: false });
  });
});
