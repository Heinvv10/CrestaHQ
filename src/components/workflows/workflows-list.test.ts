// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

/**
 * The workflows list as it renders: grouped by folder, Unfiled last. Every
 * workflow written before folders existed has no `folderId` at all, and one
 * can point at a folder deleted under it; both must still show — under
 * Unfiled — rather than vanish from the list.
 */
const m = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: m.toastError, success: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/templates/save-to-library-dialog", () => ({
  SaveToLibraryButton: () => null,
}));
import { FOLDERS_LOAD_ERROR, WorkflowsList } from "./workflows-list";

const trigger = { type: "contact.created" };
const WORKFLOWS = [
  { id: "legacy", name: "Legacy", status: "draft", trigger },
  { id: "filed", name: "Filed", status: "active", trigger, folderId: "f1" },
  { id: "orphan", name: "Orphan", status: "draft", trigger, folderId: "gone" },
];
const FOLDERS = [
  { id: "f2", name: "Empty", order: 1 },
  { id: "f1", name: "Sales", order: 0 },
];

function stubFetch(folders: Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/workflow-folders")
        ? folders
        : new Response(JSON.stringify({ workflows: WORKFLOWS })),
    ),
  );
}

async function render() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const el = document.createElement("div");
  const root = createRoot(el);
  await act(async () => root.render(createElement(WorkflowsList, { saId: "sa1" })));
  const groups = [...el.querySelectorAll<HTMLElement>('[data-testid="workflow-folder"]')].map(
    (g) => ({
      name: g.dataset.name,
      count: g.dataset.count,
      rows: [...g.querySelectorAll<HTMLElement>('[data-testid="workflow-row"]')].map(
        (r) => r.dataset.name,
      ),
    }),
  );
  root.unmount();
  return groups;
}

afterEach(() => {
  vi.unstubAllGlobals();
  m.toastError.mockReset();
});

it("groups by folder order with Unfiled last, holding legacy and orphaned workflows", async () => {
  stubFetch(new Response(JSON.stringify({ folders: FOLDERS })));

  expect(await render()).toEqual([
    { name: "Sales", count: "1", rows: ["Filed"] },
    { name: "Empty", count: "0", rows: [] },
    { name: "Unfiled", count: "2", rows: ["Legacy", "Orphan"] },
  ]);
  expect(m.toastError).not.toHaveBeenCalled();
});

it("a failed folder load says so and still shows every workflow", async () => {
  stubFetch(new Response("{}", { status: 500 }));

  expect(await render()).toEqual([
    { name: "Unfiled", count: "3", rows: ["Legacy", "Filed", "Orphan"] },
  ]);
  expect(m.toastError).toHaveBeenCalledWith(FOLDERS_LOAD_ERROR);
});
