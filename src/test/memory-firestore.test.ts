import { describe, expect, it } from "vitest";
import { createMemoryFirestore } from "./memory-firestore";

/** The in-memory Firestore's cursor: position-based, and loud when misused. */

describe("startAfter", () => {
  it("continues after the cursor doc in the query's order", async () => {
    const mem = createMemoryFirestore();
    for (const [id, n] of [["a", 3], ["b", 2], ["c", 1]] as const) mem.seed(`log/${id}`, { n });
    const q = mem.db.collection("log").orderBy("n", "desc");
    const first = (await q.limit(1).get()).docs[0];
    expect((await q.startAfter(first).get()).docs.map((d) => d.id)).toEqual(["b", "c"]);
  });

  it("throws when the cursor doc is not in the query's result, instead of returning everything", async () => {
    const mem = createMemoryFirestore();
    mem.seed("log/a", { n: 1, kind: "x" });
    mem.seed("log/b", { n: 2, kind: "y" });
    const cursor = await mem.db.doc("log/a").get();
    await expect(mem.db.collection("log").where("kind", "==", "y").startAfter(cursor).get()).rejects.toThrow(/cursor/);
  });
});

describe("batch", () => {
  it("applies nothing until commit, then everything", async () => {
    const mem = createMemoryFirestore();
    const b = mem.db.batch();
    b.set(mem.db.doc("a/1"), { n: 1 });
    b.create(mem.db.doc("a/2"), { n: 2 });
    expect(mem.read("a/1")).toBeUndefined();
    await b.commit();
    expect([mem.read("a/1"), mem.read("a/2")]).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("is all-or-nothing: a failing create leaves the other writes unapplied", async () => {
    const mem = createMemoryFirestore();
    mem.seed("a/2", { n: 0 });
    const b = mem.db.batch();
    b.set(mem.db.doc("a/1"), { n: 1 });
    b.create(mem.db.doc("a/2"), { n: 2 });
    await expect(b.commit()).rejects.toThrow(/ALREADY_EXISTS/);
    expect(mem.read("a/1")).toBeUndefined();
    expect(mem.read("a/2")).toEqual({ n: 0 });
  });
});
