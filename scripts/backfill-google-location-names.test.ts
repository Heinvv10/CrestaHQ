import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { backfillGoogleLocationNames, parseArgs, planLocationNames } from "./backfill-google-location-names";

const listing = (locationName: string) => ({ accountName: "accounts/1", locationName, title: locationName });

/** Minimal in-memory Firestore covering exactly what the script calls. */
function fakeDb(rows: Map<string, Record<string, unknown>>) {
  const snap = (id: string) => ({ id, ref: { id }, exists: rows.has(id), data: () => rows.get(id) });
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

describe("planLocationNames", () => {
  it("single listing: [main]", () => {
    expect(planLocationNames({ googleListing: listing("locations/1") })).toEqual(["locations/1"]);
  });

  it("main then extras, in stored order", () => {
    expect(planLocationNames({
      googleListing: listing("locations/1"),
      googleExtraListings: [listing("locations/2"), listing("locations/3")],
    })).toEqual(["locations/1", "locations/2", "locations/3"]);
  });

  it("never touches a doc that already has the field, whatever it holds", () => {
    expect(planLocationNames({ googleListing: listing("locations/1"), googleLocationNames: [] })).toBeNull();
    expect(planLocationNames({ googleListing: listing("locations/1"), googleLocationNames: ["locations/9"] })).toBeNull();
    expect(planLocationNames({ googleListing: listing("locations/1"), googleLocationNames: null })).toBeNull();
  });

  it("no listing → nothing to write", () => {
    expect(planLocationNames({})).toBeNull();
    expect(planLocationNames({ googleListing: null })).toBeNull();
    expect(planLocationNames({ googleListing: { title: "no locationName" } })).toBeNull();
  });
});

describe("backfillGoogleLocationNames", () => {
  const seed = () =>
    new Map<string, Record<string, unknown>>([
      ["a", { name: "A", googleListing: listing("locations/1") }],
      ["b", { name: "B", googleListing: null }],
      ["c", { name: "C", googleListing: listing("locations/3"), googleLocationNames: ["locations/3"] }],
      ["d", { name: "D" }],
    ]);

  it("dry run writes nothing", async () => {
    const rows = seed();
    const before = JSON.stringify([...rows]);
    const r = await backfillGoogleLocationNames(fakeDb(rows), false);
    expect(r).toEqual({ apply: false, scanned: 4, planned: 1, written: 0 });
    expect(JSON.stringify([...rows])).toBe(before);
  });

  it("--apply writes only googleLocationNames, and a rerun plans nothing", async () => {
    const rows = seed();
    const others = JSON.stringify([...rows].filter(([id]) => id !== "a"));
    expect((await backfillGoogleLocationNames(fakeDb(rows), true)).written).toBe(1);
    expect(rows.get("a")).toEqual({ name: "A", googleListing: listing("locations/1"), googleLocationNames: ["locations/1"] });
    expect(JSON.stringify([...rows].filter(([id]) => id !== "a"))).toBe(others);
    expect(await backfillGoogleLocationNames(fakeDb(rows), true)).toEqual({ apply: true, scanned: 4, planned: 0, written: 0 });
  });
});
