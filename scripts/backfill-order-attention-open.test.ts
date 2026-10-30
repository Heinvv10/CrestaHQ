import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import {
  backfillOrderAttentionOpen,
  needsAttentionOpen,
  parseArgs,
} from "./backfill-order-attention-open";

/** Minimal in-memory Firestore covering exactly what the script calls. */
function fakeDb(
  rows: Map<string, Record<string, unknown>>,
  opts: { beforeTx?: () => void } = {}
) {
  const ref = (path: string) => ({ path, id: path.split("/").at(-1)! });
  // Snapshots freeze the data at read time, like the real SDK.
  const snap = (path: string) => {
    const data = rows.get(path);
    return {
      id: path.split("/").at(-1)!,
      ref: ref(path),
      exists: rows.has(path),
      data: () => data,
    };
  };
  const updates: [string, Record<string, unknown>][] = [];
  const db = {
    collection: (name: string) => {
      let afterId = "";
      let lim = Infinity;
      const q = {
        // Only `attention != null` is ever asked for.
        where: (_f: string, _op: string, _v: unknown) => q,
        orderBy: () => q,
        limit: (n: number) => ((lim = n), q),
        startAfter: (d: { id: string }) => ((afterId = d.id), q),
        get: async () => {
          const ordered = [...rows.keys()]
            .filter((p) => p.startsWith(`${name}/`))
            .filter((p) => rows.get(p)!.attention != null)
            .sort((a, b) => {
              const av = String(rows.get(a)!.attention);
              const bv = String(rows.get(b)!.attention);
              return av < bv ? -1 : av > bv ? 1 : a < b ? -1 : a > b ? 1 : 0;
            });
          const start = afterId
            ? ordered.findIndex((p) => p.endsWith(`/${afterId}`)) + 1
            : 0;
          return { docs: ordered.slice(start, start + lim).map(snap) };
        },
      };
      return q;
    },
    runTransaction: async (fn: (tx: unknown) => unknown) => {
      opts.beforeTx?.();
      return fn({
        get: async (r: { path: string }) => snap(r.path),
        update: (r: { path: string }, data: Record<string, unknown>) => {
          updates.push([r.path, data]);
          rows.set(r.path, { ...rows.get(r.path), ...data });
        },
      });
    },
  };
  return { db: db as unknown as Firestore, updates };
}

function seed() {
  return new Map<string, Record<string, unknown>>([
    // candidate: flagged before the field existed
    ["orders/o1", { attention: "second payment", subAccountId: "a" }],
    // candidate in another tenant — scanned too
    ["orders/o2", { attention: "amount changed", subAccountId: "b", attentionResolvedAt: null }],
    // already set true
    ["orders/o3", { attention: "x", attentionOpen: true }],
    // already set false
    ["orders/o4", { attention: "x", attentionOpen: false }],
    // resolved before field existed
    ["orders/o5", { attention: "x", attentionResolvedAt: { seconds: 1 } }],
    // empty-string attention — not a candidate
    ["orders/o6", { attention: "   " }],
    // never flagged — not returned by the != null query
    ["orders/o7", { attention: null }],
    ["orders/o8", { subAccountId: "a" }],
  ]);
}

describe("parseArgs", () => {
  it("defaults to dry-run", () => {
    expect(parseArgs([])).toEqual({ write: false });
    expect(parseArgs(["--write"])).toEqual({ write: true });
  });
});

describe("needsAttentionOpen", () => {
  it("rejects empty attention, present attentionOpen, and resolved rows", () => {
    expect(needsAttentionOpen({ attention: "x" })).toBe(true);
    expect(needsAttentionOpen({ attention: "x", attentionResolvedAt: null })).toBe(true);
    expect(needsAttentionOpen({ attention: "" })).toBe(false);
    expect(needsAttentionOpen({ attention: " " })).toBe(false);
    expect(needsAttentionOpen({ attention: null })).toBe(false);
    expect(needsAttentionOpen({ attention: 5 })).toBe(false);
    expect(needsAttentionOpen({ attention: "x", attentionOpen: true })).toBe(false);
    expect(needsAttentionOpen({ attention: "x", attentionOpen: false })).toBe(false);
    expect(needsAttentionOpen({ attention: "x", attentionResolvedAt: { seconds: 1 } })).toBe(false);
  });
});

describe("backfillOrderAttentionOpen", () => {
  it("dry-run counts and writes nothing", async () => {
    const rows = seed();
    const { db, updates } = fakeDb(rows);
    const r = await backfillOrderAttentionOpen(db, { write: false });
    expect(r).toEqual({
      write: false,
      scanned: 6,
      candidates: 2,
      alreadySet: 2,
      alreadyResolved: 1,
      written: 0,
    });
    expect(updates).toEqual([]);
    expect(rows.get("orders/o1")!.attentionOpen).toBeUndefined();
  });

  it("--write sets attentionOpen:true only on candidates, and a second run plans zero", async () => {
    const rows = seed();
    const { db, updates } = fakeDb(rows);
    const r = await backfillOrderAttentionOpen(db, { write: true });
    expect(r).toMatchObject({ candidates: 2, written: 2 });
    expect(updates.sort()).toEqual([
      ["orders/o1", { attentionOpen: true }],
      ["orders/o2", { attentionOpen: true }],
    ]);
    expect(rows.get("orders/o1")).toEqual({
      attention: "second payment",
      subAccountId: "a",
      attentionOpen: true,
    });
    expect(rows.get("orders/o3")).toEqual({ attention: "x", attentionOpen: true });
    expect(rows.get("orders/o4")).toEqual({ attention: "x", attentionOpen: false });
    expect(rows.get("orders/o5")).toEqual({ attention: "x", attentionResolvedAt: { seconds: 1 } });
    expect(rows.get("orders/o6")).toEqual({ attention: "   " });

    const again = await backfillOrderAttentionOpen(db, { write: true });
    expect(again).toMatchObject({ scanned: 6, candidates: 0, alreadySet: 4, written: 0 });
    expect(updates).toHaveLength(2);
  });

  it("transaction re-read skips a row resolved between plan and write", async () => {
    const rows = seed();
    const { db, updates } = fakeDb(rows, {
      beforeTx: () => {
        rows.set("orders/o1", { ...rows.get("orders/o1"), attentionResolvedAt: { seconds: 9 } });
      },
    });
    const r = await backfillOrderAttentionOpen(db, { write: true });
    expect(r).toMatchObject({ candidates: 2, written: 1 });
    expect(updates).toEqual([["orders/o2", { attentionOpen: true }]]);
    expect(rows.get("orders/o1")!.attentionOpen).toBeUndefined();
  });

  it("paginates across pages without skipping or repeating rows", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < 601; i++)
      rows.set(`orders/p${String(i).padStart(4, "0")}`, { attention: `n${i % 7}` });
    const { db, updates } = fakeDb(rows);
    const r = await backfillOrderAttentionOpen(db, { write: true });
    expect(r).toMatchObject({ scanned: 601, candidates: 601, written: 601 });
    expect(new Set(updates.map(([p]) => p)).size).toBe(601);
  });
});
