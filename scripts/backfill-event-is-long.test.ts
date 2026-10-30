import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { backfillEventIsLong, parseArgs, planIsLong } from "./backfill-event-is-long";

const H = 3600_000;
const ts = (ms: number) => ({ toMillis: () => ms, toDate: () => new Date(ms) });
const event = (hours: number, extra: Record<string, unknown> = {}) => ({
  startAt: ts(0),
  endAt: ts(hours * H),
  ...extra,
});

/** Minimal in-memory Firestore covering exactly what the script calls. */
function fakeDb(rows: Map<string, Record<string, unknown>>) {
  const snap = (id: string) => ({
    id,
    ref: { id },
    exists: rows.has(id),
    data: () => rows.get(id),
  });
  let afterId = "";
  let lim = Infinity;
  const q = {
    select: () => q,
    orderBy: () => q,
    limit: (n: number) => ((lim = n), q),
    startAfter: (d: { id: string }) => ((afterId = d.id), q),
    get: async () => {
      const docs = [...rows.keys()].sort().filter((id) => id > afterId).slice(0, lim).map(snap);
      afterId = "";
      return { docs };
    },
  };
  const db = {
    collection: () => q,
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>) =>
      fn({
        get: async (ref: { id: string }) => snap(ref.id),
        update: (ref: { id: string }, patch: Record<string, unknown>) =>
          rows.set(ref.id, { ...rows.get(ref.id), ...patch }),
      }),
  };
  return db as unknown as Firestore;
}

describe("parseArgs", () => {
  it("requires an explicit project and defaults to a dry run", () => {
    expect(() => parseArgs([])).toThrow(/--project/);
    expect(() => parseArgs(["--project", "--apply"])).toThrow(/--project/);
    expect(parseArgs(["--project", "p1"])).toEqual({ projectId: "p1", apply: false });
    expect(parseArgs(["--project", "p1", "--apply"])).toEqual({ projectId: "p1", apply: true });
  });
});

describe("planIsLong", () => {
  it("flags events over 8 h, unflags stale ones, leaves the rest", () => {
    expect(planIsLong(event(9))).toBe(true);
    expect(planIsLong(event(9, { isLong: true }))).toBeNull();
    expect(planIsLong(event(1, { isLong: true }))).toBe(false);
    expect(planIsLong(event(8))).toBeNull();
    expect(planIsLong({ startAt: null })).toBeNull();
  });
});

describe("backfillEventIsLong", () => {
  const seed = () =>
    new Map<string, Record<string, unknown>>([
      ["a", event(48)],
      ["b", event(1)],
      ["c", event(2, { isLong: true })],
      ["d", event(30, { isLong: true })],
    ]);

  it("dry run writes nothing", async () => {
    const rows = seed();
    const r = await backfillEventIsLong(fakeDb(rows), false);
    expect(r).toEqual({ apply: false, scanned: 4, toLong: 1, toShort: 1, written: 0 });
    expect(rows.get("a")!.isLong).toBeUndefined();
  });

  it("--apply writes only isLong, and a rerun plans nothing", async () => {
    const rows = seed();
    expect((await backfillEventIsLong(fakeDb(rows), true)).written).toBe(2);
    expect(rows.get("a")!.isLong).toBe(true);
    expect(rows.get("c")!.isLong).toBe(false);
    expect(rows.get("b")!.isLong).toBeUndefined();
    expect(await backfillEventIsLong(fakeDb(rows), true)).toMatchObject({ toLong: 0, toShort: 0, written: 0 });
  });
});
