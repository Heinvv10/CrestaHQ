// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/** A failed load renders the error card — never the empty-library state. */

const m = vi.hoisted(() => ({ library: vi.fn() }));
vi.mock("@/hooks/use-media-library", () => ({ useMediaLibrary: m.library }));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseStorage: () => ({}) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
import { MediaLibrary } from "./media-library";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = () =>
  act(async () => root.render(createElement(MediaLibrary, { subAccountId: "sa1", canManage: true })));

it("shows the error card when the library fails to load", async () => {
  m.library.mockReturnValue({ assets: [], folders: [], hydrated: false, error: new Error("permission-denied") });
  await render();
  expect(container.querySelector("[data-testid=media-load-error]")?.textContent).toContain(
    "Couldn't load the media library",
  );
  expect(container.querySelector("[data-testid=media-grid]")).toBeNull();
});

it("shows the grid and upload input for an admin once loaded", async () => {
  m.library.mockReturnValue({ assets: [], folders: [], hydrated: true, error: null });
  await render();
  expect(container.querySelector("[data-testid=media-load-error]")).toBeNull();
  expect(container.querySelector("[data-testid=media-grid]")).not.toBeNull();
  expect(container.querySelector("[data-testid=media-upload-input]")).not.toBeNull();
});

it("hides upload and new-folder for a non-admin", async () => {
  m.library.mockReturnValue({ assets: [], folders: [], hydrated: true, error: null });
  await act(async () => root.render(createElement(MediaLibrary, { subAccountId: "sa1", canManage: false })));
  expect(container.querySelector("[data-testid=media-grid]")).not.toBeNull();
  expect(container.querySelector("[data-testid=media-upload-input]")).toBeNull();
  expect(container.querySelector("[data-testid=media-new-folder]")).toBeNull();
});
