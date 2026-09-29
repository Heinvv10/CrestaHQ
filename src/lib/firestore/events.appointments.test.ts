import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * subscribeToAppointments must never read a sub-account's whole history:
 * both halves carry a date bound, an order and a limit, and the two
 * bounds partition on the same instant. The query functions are mocked to
 * plain descriptors so the constraints actually sent can be asserted on.
 */
type Next = (snap: unknown) => void;
const m = vi.hoisted(() => ({
  queries: [] as unknown[][],
  nexts: [] as Next[],
  unsubs: 0,
}));
vi.mock("firebase/firestore", () => ({
  collection: vi.fn(() => "events-col"),
  doc: vi.fn(),
  addDoc: vi.fn(),
  updateDoc: vi.fn(),
  deleteDoc: vi.fn(),
  serverTimestamp: vi.fn(),
  Timestamp: { fromMillis: (ms: number) => ({ ms }), fromDate: vi.fn() },
  where: (field: string, op: string, value: unknown) => ({ where: [field, op, value] }),
  orderBy: (field: string, dir: string) => ({ orderBy: [field, dir] }),
  limit: (n: number) => ({ limit: n }),
  query: (_col: unknown, ...constraints: unknown[]) => {
    m.queries.push(constraints);
    return constraints;
  },
  onSnapshot: (_q: unknown, next: Next) => {
    m.nexts.push(next);
    return () => {
      m.unsubs++;
    };
  },
}));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
vi.mock("@/lib/firestore/activities", () => ({ addActivity: vi.fn() }));
vi.mock("@/lib/firestore/territory-inherit", () => ({ territoryIdForContact: vi.fn() }));
import {
  APPOINTMENTS_UPCOMING_LIMIT,
  subscribeToAppointments,
} from "./events";

const SCOPE = { agencyId: "ag1", subAccountId: "sa1" };
const NOW = Date.UTC(2026, 8, 29, 12);

function snap(events: { id: string; startMs: number }[]) {
  return {
    size: events.length,
    docs: events.map((e) => ({
      id: e.id,
      data: () => ({ title: e.id, startAt: { toDate: () => new Date(e.startMs) } }),
    })),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  m.queries = [];
  m.nexts = [];
  m.unsubs = 0;
});
afterEach(() => vi.useRealTimers());

it("upcoming half: startAt >= now, soonest first, capped", () => {
  subscribeToAppointments(SCOPE, { pastLimit: 200 }, vi.fn());
  expect(m.queries[0]).toEqual([
    { where: ["subAccountId", "==", "sa1"] },
    { where: ["startAt", ">=", { ms: NOW }] },
    { orderBy: ["startAt", "asc"] },
    { limit: APPOINTMENTS_UPCOMING_LIMIT },
  ]);
});

it("past half: startAt < the same instant, newest first, limited to pastLimit", () => {
  subscribeToAppointments(SCOPE, { pastLimit: 400 }, vi.fn());
  expect(m.queries[1]).toEqual([
    { where: ["subAccountId", "==", "sa1"] },
    { where: ["startAt", "<", { ms: NOW }] },
    { orderBy: ["startAt", "desc"] },
    { limit: 400 },
  ]);
});

it("a territory filter goes on both halves", () => {
  subscribeToAppointments(SCOPE, { territoryFilter: ["t1"], pastLimit: 200 }, vi.fn());
  for (const q of m.queries) {
    expect(q).toContainEqual({ where: ["territoryId", "in", ["t1"]] });
  }
});

it("a collaborator with no territories gets an empty list and no query", () => {
  const cb = vi.fn();
  subscribeToAppointments(SCOPE, { territoryFilter: [], pastLimit: 200 }, cb);
  expect(m.queries).toHaveLength(0);
  expect(cb).toHaveBeenCalledWith({ events: [], upcomingTruncated: false, pastTruncated: false });
});

it("waits for both halves, merges them oldest first, and flags a full half as truncated", () => {
  const cb = vi.fn();
  subscribeToAppointments(SCOPE, { pastLimit: 2 }, cb);
  m.nexts[0](snap([{ id: "u1", startMs: NOW + 1000 }]));
  expect(cb).not.toHaveBeenCalled();
  m.nexts[1](snap([{ id: "p2", startMs: NOW - 1000 }, { id: "p1", startMs: NOW - 5000 }]));
  const out = cb.mock.calls[0][0];
  expect(out.events.map((e: { id: string }) => e.id)).toEqual(["p1", "p2", "u1"]);
  expect(out.upcomingTruncated).toBe(false);
  expect(out.pastTruncated).toBe(true);
});

it("an event seen in both halves mid-reschedule is listed once", () => {
  const cb = vi.fn();
  subscribeToAppointments(SCOPE, { pastLimit: 200 }, cb);
  m.nexts[0](snap([{ id: "e1", startMs: NOW + 1000 }]));
  m.nexts[1](snap([{ id: "e1", startMs: NOW - 1000 }]));
  expect(cb.mock.calls[0][0].events).toHaveLength(1);
});

it("unsubscribing stops both listeners", () => {
  const unsub = subscribeToAppointments(SCOPE, { pastLimit: 200 }, vi.fn());
  unsub();
  expect(m.unsubs).toBe(2);
});
