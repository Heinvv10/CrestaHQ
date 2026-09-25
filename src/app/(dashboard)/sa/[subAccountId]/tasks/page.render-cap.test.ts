// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RENDER_STEP } from "@/components/show-more-rows";
import type { Task } from "@/types/tasks";

// Stable objects, as the real hooks return: a fresh `user` per render
// re-runs the page's subscribe effect forever.
const stable = vi.hoisted(() => ({
  auth: { user: { uid: "u1" }, loading: false },
  sub: { subAccountId: "sa", agencyId: "ag" },
  territory: { ready: true, filter: null },
  members: { members: [] },
  contacts: { contacts: [], loading: false, error: null },
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => stable.auth,
}));
vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => stable.sub,
}));
vi.mock("@/hooks/use-effective-territory-filter", () => ({
  useEffectiveTerritoryFilter: () => stable.territory,
}));
vi.mock("@/hooks/use-sub-account-members", () => ({
  useSubAccountMembers: () => stable.members,
}));
vi.mock("@/context/contacts-context", () => ({
  useSubAccountContacts: () => stable.contacts,
}));
// 250 open, undated tasks — undated tasks land in "upcoming", so that tab
// alone forces DOM capping.
const TASKS: Task[] = Array.from({ length: 250 }, (_, i) => ({
  id: `t${i}`,
  title: `Task ${i}`,
  notes: "",
  dueAt: null,
  completed: false,
  completedAt: null,
  contactId: null,
  dealId: null,
  eventId: null,
  agencyId: "ag",
  subAccountId: "sa",
  createdByUid: "u1",
  createdAt: null,
  updatedAt: null,
}));
vi.mock("@/lib/firestore/tasks", () => ({
  subscribeToTasks: (
    _scope: unknown,
    _opts: unknown,
    cb: (l: Task[]) => void,
  ) => {
    cb(TASKS);
    return () => {};
  },
}));
vi.mock("@/components/tasks/task-dialog", () => ({
  TaskDialog: () => null,
}));
vi.mock("@/components/tasks/task-item", () => ({
  TaskItem: ({ task }: { task: Task }) =>
    createElement("div", { className: "task-item-mock", key: task.id }),
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("renders at most RENDER_STEP rows for a 250-task sub-account, then Show more reveals the rest", async () => {
  const { default: TasksPage } = await import("./page");
  await act(async () => root.render(createElement(TasksPage)));
  // Undated tasks are "upcoming"; the page opens on "today". Switch to Upcoming.
  const upcomingTab = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.trim().startsWith("Upcoming"),
  );
  expect(upcomingTab).toBeTruthy();
  await act(async () =>
    upcomingTab!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );

  const rowsAfterLoad = container.querySelectorAll(".task-item-mock");
  expect(rowsAfterLoad.length).toBe(RENDER_STEP);

  const showMoreButton = Array.from(
    container.querySelectorAll("button"),
  ).find((b) => b.textContent?.startsWith("Show"));
  expect(showMoreButton).toBeTruthy();

  await act(async () => showMoreButton!.dispatchEvent(
    new MouseEvent("click", { bubbles: true }),
  ));

  const rowsAfterMore = container.querySelectorAll(".task-item-mock");
  expect(rowsAfterMore.length).toBe(RENDER_STEP * 2);
  expect(TASKS.length).toBeGreaterThan(RENDER_STEP * 2);
});
