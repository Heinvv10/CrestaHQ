import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Internal-note @mentions → tasks. Driven through the real route, the real
 * requireSubAccountMember guard, the real isAssignableMember check and the
 * real task service, over an in-memory Firestore. Only Auth claims and the
 * webhook dispatch are stubbed.
 */
const mem = createMemoryFirestore();
const claims = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({
    getUser: async (uid: string) => ({ customClaims: claims.get(uid) ?? {} }),
  }),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));

const { POST } = await import("./route");

const NOTE = "contacts/c1/notes/n1";

function call(uid: string, { sa = "sa1", contactId = "c1", noteId = "n1" } = {}) {
  return POST(
    new Request(
      `https://crm.test/api/sub-accounts/${sa}/contacts/${contactId}/notes/${noteId}/mention-tasks`,
      // A body that tries to steer the tasks — the route must ignore it.
      {
        method: "POST",
        headers: { "x-user-uid": uid, "content-type": "application/json" },
        body: JSON.stringify({ mentionedUids: ["intruder"], title: "pwned" }),
      }
    ),
    { params: Promise.resolve({ id: sa, contactId, noteId }) }
  );
}

const member = (sa: string, uid: string, status: string, displayName: string) =>
  mem.seed(`subAccounts/${sa}/subAccountMembers/${uid}`, { status, displayName, role: "collaborator" });

beforeEach(() => {
  mem.clear();
  claims.clear();
  for (const uid of ["author", "mike", "gone", "other", "intruder", "outsider"]) {
    claims.set(uid, { status: "active", agencyId: "ag1", agencyRole: null });
  }
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("subAccounts/sa2", { agencyId: "ag1" });
  member("sa1", "author", "active", "Hein");
  member("sa1", "mike", "active", "Michael Smith");
  member("sa1", "gone", "removed", "Former Person");
  member("sa1", "intruder", "active", "Intruder");
  member("sa2", "other", "active", "Other Sub");
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Naledi" });
  mem.seed(NOTE, {
    content: "@Michael Smith please call back",
    createdBy: "author",
    source: "conversation",
    mentionedUids: ["mike"],
  });
});

const tasks = () => mem.list("tasks");

it("creates exactly one task per mentioned active member, assigned to them", async () => {
  const res = await call("author");
  expect(res.status).toBe(201);
  const all = tasks();
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({
    assignedToUid: "mike",
    title: "Mentioned by Hein in Naledi's conversation",
    notes: "@Michael Smith please call back",
    contactId: "c1",
    agencyId: "ag1",
    subAccountId: "sa1",
    createdByUid: "author",
    completed: false,
    mode: "live",
  });
  const due = all[0].dueAt as Date;
  expect(due.toDateString()).toBe(new Date().toDateString());
  expect((await res.json()).taskIds).toEqual([all[0].id]);
});

it("creates nothing for a removed member, a non-member, or a member of another sub-account", async () => {
  mem.seed(NOTE, {
    content: "@Former Person @Nobody @Other Sub",
    createdBy: "author",
    mentionedUids: ["gone", "nobody", "other"],
  });
  const res = await call("author");
  expect(res.status).toBe(200);
  expect(tasks()).toHaveLength(0);
});

it("never tasks the author for mentioning themselves", async () => {
  mem.seed(NOTE, {
    content: "@Hein and @Michael Smith",
    createdBy: "author",
    mentionedUids: ["author", "mike"],
  });
  await call("author");
  expect(tasks().map((t) => t.assignedToUid)).toEqual(["mike"]);
});

it("truncates a long note into the task notes", async () => {
  mem.seed(NOTE, { content: "x".repeat(900), createdBy: "author", mentionedUids: ["mike"] });
  await call("author");
  expect(tasks()[0].notes).toBe(`${"x".repeat(500)}…`);
});

it("creates the tasks once — a repeat call creates nothing", async () => {
  expect((await call("author")).status).toBe(201);
  expect((await call("author")).status).toBe(409);
  expect(tasks()).toHaveLength(1);
});

it("rejects a caller who is not an active member, even on their own note", async () => {
  // Not a member at all, removed from this sub-account, a member elsewhere.
  for (const uid of ["outsider", "gone", "other"]) {
    mem.seed(NOTE, { content: "@Michael Smith", createdBy: uid, mentionedUids: ["mike"] });
    const res = await call(uid);
    expect(res.status).toBe(403);
  }
  expect(tasks()).toHaveLength(0);
  expect(mem.read(NOTE)?.mentionTasksAt).toBeUndefined();
});

it("rejects a member who did not write the note", async () => {
  const res = await call("mike");
  expect(res.status).toBe(403);
  expect(tasks()).toHaveLength(0);
});

it("refuses a contact that belongs to another sub-account", async () => {
  member("sa2", "author", "active", "Hein");
  const res = await call("author", { sa: "sa2" });
  expect(res.status).toBe(404);
  expect(tasks()).toHaveLength(0);
});
