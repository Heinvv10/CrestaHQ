import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
vi.mock("@/lib/firestore/activities", () => ({ addActivity: vi.fn() }));
vi.mock("@/lib/firestore/territory-inherit", () => ({
  territoryIdForContact: vi.fn(),
}));
vi.mock("firebase/firestore", () => ({
  collection: (_db: unknown, path: string) => path,
  where: (...args: unknown[]) => args,
  query: (...args: unknown[]) => args,
  onSnapshot: m.listen,
  doc: vi.fn(),
  addDoc: vi.fn(),
  deleteDoc: vi.fn(),
  updateDoc: vi.fn(),
  serverTimestamp: vi.fn(),
  Timestamp: {
    fromDate: (d: Date) => ({ __ts: d.getTime() }),
  },
}));
import { subscribeToDueTodayCount } from "./tasks";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 25, 14, 0, 0)); // 2026-09-25 14:00 local
});
afterEach(() => vi.useRealTimers());

function expectedCutoff(): number {
  const cutoff = new Date(2026, 8, 25, 14, 0, 0);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() + 1); // 2026-09-26 00:00 local
  return cutoff.getTime();
}

it("the due-today badge queries only open tasks due by tomorrow, territory-scoped", () => {
  subscribeToDueTodayCount("sa", vi.fn(), vi.fn(), ["north"]);
  const q = m.listen.mock.calls[0][0] as unknown[];
  expect(q[0]).toBe("tasks");
  expect(q[1]).toEqual(["subAccountId", "==", "sa"]);
  expect(q[2]).toEqual(["territoryId", "in", ["north"]]);
  expect(q[3]).toEqual(["completed", "==", false]);
  const [field, op, bound] = q[4] as [string, string, { __ts: number }];
  expect(field).toBe("dueAt");
  expect(op).toBe("<");
  expect(bound.__ts).toBe(expectedCutoff());
});

it("with no territory filter, the query omits the territory clause", () => {
  subscribeToDueTodayCount("sa", vi.fn());
  const q = m.listen.mock.calls[0][0] as unknown[];
  expect(q).toEqual([
    "tasks",
    ["subAccountId", "==", "sa"],
    ["completed", "==", false],
    ["dueAt", "<", { __ts: expectedCutoff() }],
  ]);
});

it("never issues a broad query for an empty territory scope", () => {
  const receive = vi.fn();
  subscribeToDueTodayCount("sa", receive, vi.fn(), []);
  expect(m.listen).not.toHaveBeenCalled();
  expect(receive).toHaveBeenCalledWith(0);
});

it("the badge counts the matching docs", () => {
  const receive = vi.fn();
  subscribeToDueTodayCount("sa", receive);
  const next = m.listen.mock.calls[0][1] as (s: { size: number }) => void;
  next({ size: 4 });
  expect(receive).toHaveBeenCalledWith(4);
});

// The query above replaced client-side counting in use-due-today.ts. This
// proves the new filter (completed === false && dueAt !== null && dueAt <
// tomorrow's midnight) is equivalent to the old logic it replaced
// (`!t.completed && d && (d < nextDay || d < now)`, which simplifies to
// `d < nextDay` since `now` always precedes tomorrow's midnight) across the
// edge cases a due-date boundary can hit.
function oldClientCount(
  tasks: { completed: boolean; dueAt: Date | null }[],
): number {
  const now = new Date(2026, 8, 25, 14, 0, 0).getTime();
  const today = new Date(2026, 8, 25);
  today.setHours(0, 0, 0, 0);
  const nextDay = new Date(today);
  nextDay.setDate(nextDay.getDate() + 1);
  let n = 0;
  for (const t of tasks) {
    if (t.completed) continue;
    if (!t.dueAt) continue;
    if (t.dueAt.getTime() < nextDay.getTime() || t.dueAt.getTime() < now)
      n += 1;
  }
  return n;
}
function newQueryCount(
  tasks: { completed: boolean; dueAt: Date | null }[],
): number {
  const cutoff = expectedCutoff();
  return tasks.filter(
    (t) => t.completed === false && t.dueAt !== null && t.dueAt.getTime() < cutoff,
  ).length;
}
it("matches the old client-side count across due-date edge cases", () => {
  const fixture = [
    { completed: false, dueAt: new Date(2026, 8, 25, 9, 0, 0) }, // due today, before now
    { completed: false, dueAt: new Date(2026, 8, 25, 23, 59, 59) }, // due today, after now
    { completed: false, dueAt: new Date(2026, 8, 24, 9, 0, 0) }, // overdue
    { completed: false, dueAt: new Date(2026, 8, 26, 0, 0, 1) }, // due tomorrow
    { completed: true, dueAt: new Date(2026, 8, 25, 9, 0, 0) }, // completed, due today
    { completed: false, dueAt: null }, // no due date
  ];
  expect(newQueryCount(fixture)).toBe(3);
  expect(newQueryCount(fixture)).toBe(oldClientCount(fixture));
});
