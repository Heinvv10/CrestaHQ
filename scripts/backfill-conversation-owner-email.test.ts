import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import {
  backfillConversationOwnerEmail,
  parseArgs,
} from "./backfill-conversation-owner-email";

/** Minimal in-memory Firestore covering exactly what the script calls. */
function fakeDb(rows: Map<string, Record<string, unknown>>) {
  const ref = (path: string) => ({ path, id: path.split("/").at(-1)! });
  const snap = (path: string) => ({
    id: path.split("/").at(-1)!,
    ref: ref(path),
    exists: rows.has(path),
    data: () => rows.get(path),
  });
  const updates: [string, Record<string, unknown>][] = [];
  const db = {
    doc: ref,
    getAll: async (...refs: { path: string }[]) => refs.map((r) => snap(r.path)),
    collection: (name: string) => {
      let sub = "";
      let afterId = "";
      let lim = Infinity;
      const q = {
        where: (_f: string, _op: string, v: string) => ((sub = v), q),
        orderBy: () => q,
        limit: (n: number) => ((lim = n), q),
        startAfter: (d: { id: string }) => ((afterId = d.id), q),
        get: async () => ({
          docs: [...rows.keys()]
            .filter(
              (p) =>
                p.startsWith(`${name}/`) &&
                rows.get(p)!.subAccountId === sub &&
                p.split("/")[1] > afterId
            )
            .sort()
            .slice(0, lim)
            .map(snap),
        }),
      };
      return q;
    },
    runTransaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        get: async (r: { path: string }) => snap(r.path),
        update: (r: { path: string }, data: Record<string, unknown>) => {
          updates.push([r.path, data]);
          rows.set(r.path, { ...rows.get(r.path), ...data });
        },
      }),
  };
  return { db: db as unknown as Firestore, updates };
}

function seed() {
  return new Map<string, Record<string, unknown>>([
    // needs owner + email
    ["conversations/c1", { contactId: "c1", subAccountId: "sa", agencyId: "ag", assigneeUid: null }],
    ["contacts/c1", { subAccountId: "sa", agencyId: "ag", assignedToUid: "u1", email: "a@x.co" }],
    // already mirrored
    ["conversations/c2", { contactId: "c2", subAccountId: "sa", agencyId: "ag", assigneeUid: null, contactEmail: "b@x.co" }],
    ["contacts/c2", { subAccountId: "sa", agencyId: "ag", email: "b@x.co" }],
    // email only
    ["conversations/c3", { contactId: "c3", subAccountId: "sa", agencyId: "ag", assigneeUid: null }],
    ["contacts/c3", { subAccountId: "sa", agencyId: "ag", email: "c@x.co" }],
    // orphan (contact gone)
    ["conversations/c4", { contactId: "c4", subAccountId: "sa", agencyId: "ag", assigneeUid: null }],
    // anonymous web chat
    ["conversations/web_s", { contactId: null, subAccountId: "sa", agencyId: "ag", assigneeUid: null }],
    // another sub-account — never scanned
    ["conversations/o1", { contactId: "o1", subAccountId: "other", agencyId: "ag", assigneeUid: null }],
    ["contacts/o1", { subAccountId: "other", agencyId: "ag", assignedToUid: "u9" }],
  ]);
}

describe("parseArgs", () => {
  it("requires --sub-account and defaults to dry-run", () => {
    expect(parseArgs(["--sub-account", "sa"])).toEqual({ subAccountId: "sa", write: false });
    expect(parseArgs(["--write", "--sub-account", "sa"])).toEqual({ subAccountId: "sa", write: true });
    expect(() => parseArgs([])).toThrow(/--sub-account/);
    expect(() => parseArgs(["--write"])).toThrow(/--sub-account/);
    expect(() => parseArgs(["--sub-account", "--write"])).toThrow(/--sub-account/);
  });
});

describe("backfillConversationOwnerEmail", () => {
  it("dry-run counts and writes nothing", async () => {
    const rows = seed();
    const { db, updates } = fakeDb(rows);
    const r = await backfillConversationOwnerEmail(db, { subAccountId: "sa", write: false });
    expect(r).toMatchObject({
      scanned: 5,
      changed: 2,
      ownerChanges: 1,
      emailChanges: 2,
      unchanged: 1,
      anonymous: 1,
      orphaned: 1,
      written: 0,
    });
    expect(updates).toEqual([]);
  });

  it("--write patches only the mirror fields, only in that sub-account, and is idempotent", async () => {
    const rows = seed();
    const { db, updates } = fakeDb(rows);
    const r = await backfillConversationOwnerEmail(db, { subAccountId: "sa", write: true });
    expect(r.written).toBe(2);
    expect(updates).toEqual([
      ["conversations/c1", { assigneeUid: "u1", contactEmail: "a@x.co" }],
      ["conversations/c3", { assigneeUid: null, contactEmail: "c@x.co" }],
    ]);
    expect(rows.get("conversations/o1")!.assigneeUid).toBeNull();
    const again = await backfillConversationOwnerEmail(db, { subAccountId: "sa", write: true });
    expect(again).toMatchObject({ changed: 0, written: 0 });
  });
});
