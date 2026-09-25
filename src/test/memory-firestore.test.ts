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

describe("create", () => {
  it("docRef.create rejects on an existing doc and leaves it untouched", async () => {
    const mem = createMemoryFirestore();
    mem.seed("a/1", { n: 0 });
    await expect(mem.db.doc("a/1").create({ n: 1 })).rejects.toThrow(/ALREADY_EXISTS/);
    expect(mem.read("a/1")).toEqual({ n: 0 });
    await mem.db.doc("a/2").create({ n: 2 });
    expect(mem.read("a/2")).toEqual({ n: 2 });
  });

  it("tx.create rejects the transaction on an existing doc and applies none of its writes", async () => {
    const mem = createMemoryFirestore();
    mem.seed("a/1", { n: 0 });
    const run = mem.db.runTransaction(async (tx) => {
      tx.set(mem.db.doc("a/3"), { n: 3 });
      tx.create(mem.db.doc("a/1"), { n: 1 });
    });
    await expect(run).rejects.toThrow(/ALREADY_EXISTS/);
    expect([mem.read("a/1"), mem.read("a/3")]).toEqual([{ n: 0 }, undefined]);
  });
});

describe("runTransaction", () => {
  it("re-runs a transaction whose read of an ABSENT doc was invalidated by a concurrent create", async () => {
    const mem = createMemoryFirestore();
    const ref = mem.db.doc("a/1");
    const claim = (who: string) =>
      mem.db.runTransaction(async (tx) => {
        const snap = (await tx.get(ref)) as { exists: boolean };
        if (snap.exists) return false;
        await new Promise((r) => setTimeout(r, 5));
        tx.set(ref, { who });
        return true;
      });
    const won = await Promise.all([claim("x"), claim("y")]);
    expect(won.filter(Boolean)).toHaveLength(1);
  });
});

describe("recursiveDelete", () => {
  it("removes the doc and everything under it, and nothing beside it", async () => {
    const mem = createMemoryFirestore();
    mem.seed("contacts/c1", { n: 1 });
    mem.seed("contacts/c1/notes/n1", { n: 2 });
    mem.seed("contacts/c10", { n: 3 });
    await mem.db.recursiveDelete(mem.db.doc("contacts/c1"));
    expect(mem.all().map((d) => d.path)).toEqual(["contacts/c10"]);
  });
});
