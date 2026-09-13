import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * In-memory Firestore for the mirror: contacts + conversations, a
 * transaction whose reads see the CURRENT state, and an optional gate that
 * holds a transaction before it starts — enough to replay two assigns whose
 * mirrors finish out of order.
 */
const m = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  wheres: [] as [string, string, unknown][],
  updates: [] as [string, Record<string, unknown>][],
  fail: false,
  gate: null as Promise<void> | null,
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => {
    // A snapshot is frozen at read time, as a real one is.
    const snap = (path: string) => {
      const data = m.docs.get(path);
      return { exists: !!data, ref: { path }, data: () => data };
    };
    return {
      doc: (path: string) => ({ path, get: async () => snap(path) }),
      collection: (name: string) => {
        const filters: [string, unknown][] = [];
        const q = {
          where: (f: string, op: string, v: unknown) => {
            m.wheres.push([f, op, v]);
            filters.push([f, v]);
            return q;
          },
          filters,
          name,
        };
        return q;
      },
      runTransaction: async (fn: (tx: unknown) => unknown) => {
        if (m.gate) await m.gate;
        if (m.fail) throw new Error("boom");
        const writes: (() => void)[] = [];
        const result = await fn({
          get: async (r: { path?: string; name?: string; filters?: [string, unknown][] }) => {
            if (r.path) return snap(r.path);
            const docs = [...m.docs.keys()]
              .filter(
                (p) =>
                  p.startsWith(`${r.name}/`) &&
                  r.filters!.every(([k, v]) => m.docs.get(p)?.[k] === v)
              )
              .sort()
              .map(snap);
            return { docs, size: docs.length, empty: docs.length === 0 };
          },
          update: (ref: { path: string }, data: Record<string, unknown>) =>
            writes.push(() => {
              m.updates.push([ref.path, data]);
              m.docs.set(ref.path, { ...m.docs.get(ref.path), ...data });
            }),
        });
        writes.forEach((w) => w());
        return result;
      },
    };
  },
}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "ts" },
}));

import {
  contactMirror,
  mirrorContactAssignee,
  planConversationMirror,
} from "./conversation-mirror";

const TENANT = { subAccountId: "sa", agencyId: "ag" };
beforeEach(() => {
  m.docs.clear();
  m.wheres = [];
  m.updates = [];
  m.fail = false;
  m.gate = null;
  m.docs.set("contacts/c1", { ...TENANT, assignedToUid: "u9", email: "c1@x.co" });
  m.docs.set("conversations/c1", { ...TENANT, contactId: "c1", assigneeUid: null });
  m.docs.set("conversations/web_s1", { ...TENANT, contactId: "c1", assigneeUid: null });
  m.docs.set("conversations/other", { ...TENANT, contactId: "c2", assigneeUid: null });
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
  it("copies the contact's CURRENT owner + email onto every conversation of that contact in that sub-account", async () => {
    const n = await mirrorContactAssignee({ contactId: "c1", subAccountId: "sa" });
    expect(n).toBe(2);
    expect(m.wheres).toEqual([
      ["subAccountId", "==", "sa"],
      ["contactId", "==", "c1"],
    ]);
    expect(m.updates).toEqual([
      ["conversations/c1", { assigneeUid: "u9", contactEmail: "c1@x.co", updatedAt: "ts" }],
      ["conversations/web_s1", { assigneeUid: "u9", contactEmail: "c1@x.co", updatedAt: "ts" }],
    ]);
    expect(m.docs.get("conversations/other")!.assigneeUid).toBeNull();
  });

  it("writes null when the contact is unassigned", async () => {
    m.docs.set("contacts/c1", { ...TENANT, assignedToUid: null, email: "" });
    await mirrorContactAssignee({ contactId: "c1", subAccountId: "sa" });
    expect(m.docs.get("conversations/c1")).toMatchObject({
      assigneeUid: null,
      contactEmail: null,
    });
  });

  // The race the transaction exists for: request A assigns "older", request B
  // assigns "newer"; B's mirror completes, then A's mirror runs LAST. A mirror
  // that carried A's value (or read the contact before its transaction) would
  // leave the conversation on "older" while the contact says "newer".
  it("an older request's mirror landing last still leaves the conversation on the contact's current owner", async () => {
    m.docs.set("contacts/c1", { ...TENANT, assignedToUid: "older" });
    let release!: () => void;
    m.gate = new Promise<void>((r) => (release = r));
    const mirrorA = mirrorContactAssignee({ contactId: "c1", subAccountId: "sa" });
    // Let A run up to wherever it waits (the gate) before B starts.
    await new Promise((r) => setTimeout(r, 0));
    // B's contact write lands while A's mirror is held, and B's mirror finishes.
    m.docs.set("contacts/c1", { ...TENANT, assignedToUid: "newer" });
    m.gate = null;
    await mirrorContactAssignee({ contactId: "c1", subAccountId: "sa" });
    expect(m.docs.get("conversations/c1")!.assigneeUid).toBe("newer");
    release();
    await mirrorA;
    expect(m.docs.get("conversations/c1")!.assigneeUid).toBe("newer");
    expect(m.docs.get("conversations/web_s1")!.assigneeUid).toBe("newer");
  });

  it("never copies from a missing or foreign-tenant contact", async () => {
    m.docs.set("contacts/c1", { subAccountId: "other", agencyId: "ag", assignedToUid: "x" });
    expect(await mirrorContactAssignee({ contactId: "c1", subAccountId: "sa" })).toBe(0);
    m.docs.delete("contacts/c1");
    expect(await mirrorContactAssignee({ contactId: "c1", subAccountId: "sa" })).toBe(0);
    expect(m.updates).toEqual([]);
  });

  it("does nothing when the contact has no conversation yet", async () => {
    m.docs.set("contacts/c3", { ...TENANT, assignedToUid: "u9" });
    expect(await mirrorContactAssignee({ contactId: "c3", subAccountId: "sa" })).toBe(0);
    expect(m.updates).toEqual([]);
  });

  it("logs and returns 0 instead of failing the contact save", async () => {
    m.fail = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      mirrorContactAssignee({ contactId: "c1", subAccountId: "sa" })
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
