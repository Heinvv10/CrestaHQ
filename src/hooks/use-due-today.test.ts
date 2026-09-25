// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * The due-today badge counts through a narrow query whose "before tomorrow"
 * bound is fixed at subscribe time. The Sidebar never remounts, so the hook
 * must re-subscribe at local midnight, and must scope by territory.
 */
const m = vi.hoisted(() => ({
  subscribe: vi.fn(),
  auth: { user: { uid: "u1" }, loading: false },
  territory: { ready: true, filter: null as string[] | null },
}));
vi.mock("@/lib/firestore/tasks", () => ({
  subscribeToDueTodayCount: (...a: unknown[]) => m.subscribe(...a),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => m.auth }));
vi.mock("@/hooks/use-effective-territory-filter", () => ({
  useEffectiveTerritoryFilter: () => m.territory,
}));

import { useDueTodayCount } from "./use-due-today";

let latest = -1;
function Probe({ sa }: { sa: string | null }) {
  latest = useDueTodayCount(sa);
  return null;
}

let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  m.subscribe.mockReset();
  m.subscribe.mockImplementation(
    (_sa: string, cb: (n: number) => void) => {
      cb(3);
      return () => undefined;
    },
  );
  m.territory = { ready: true, filter: null };
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(sa: string | null) {
  await act(async () => root.render(createElement(Probe, { sa })));
}

it("counts through the narrow query, scoped by territory", async () => {
  m.territory = { ready: true, filter: ["global", "north"] };
  await render("sa1");
  expect(m.subscribe).toHaveBeenCalledTimes(1);
  expect(m.subscribe.mock.calls[0][0]).toBe("sa1");
  expect(m.subscribe.mock.calls[0][3]).toEqual(["global", "north"]);
  expect(latest).toBe(3);
});

it("does not subscribe before the territory filter is ready", async () => {
  m.territory = { ready: false, filter: null };
  await render("sa1");
  expect(m.subscribe).not.toHaveBeenCalled();
  expect(latest).toBe(0);
});

it("re-subscribes just after local midnight so the bound moves to the new day", async () => {
  vi.setSystemTime(new Date(2026, 8, 25, 23, 59, 50));
  await render("sa1");
  expect(m.subscribe).toHaveBeenCalledTimes(1);
  await act(async () => {
    vi.advanceTimersByTime(5_000); // 23:59:55 — still the same day
  });
  expect(m.subscribe).toHaveBeenCalledTimes(1);
  await act(async () => {
    vi.advanceTimersByTime(10_000); // 00:00:05 — the next day
  });
  expect(m.subscribe).toHaveBeenCalledTimes(2);
});
