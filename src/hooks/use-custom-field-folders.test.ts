// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ subscribe: vi.fn(), toastError: vi.fn() }));
vi.mock("@/lib/firestore/custom-field-folders", () => ({
  subscribeToCustomFieldFolders: m.subscribe,
}));
vi.mock("sonner", () => ({ toast: { error: m.toastError } }));
import { FOLDERS_LOAD_ERROR, useCustomFieldFolders } from "./use-custom-field-folders";

let container: HTMLDivElement;
let root: Root;
let seen: unknown[] = [];

function Probe() {
  const folders = useCustomFieldFolders("sa1", "contact");
  seen.push(folders);
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  m.subscribe.mockReset();
  m.toastError.mockReset();
  seen = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("toasts and falls back to no folders when the subscription errors", async () => {
  let onError: ((e: Error) => void) | undefined;
  m.subscribe.mockImplementation((_sa, _entity, cb, err) => {
    cb([{ id: "f1", name: "Billing", order: 0 }]);
    onError = err;
    return () => {};
  });
  await act(async () => root.render(createElement(Probe)));
  expect(seen.at(-1)).toEqual([{ id: "f1", name: "Billing", order: 0 }]);

  await act(async () => onError!(new Error("permission-denied")));
  expect(m.toastError).toHaveBeenCalledWith(FOLDERS_LOAD_ERROR);
  expect(seen.at(-1)).toEqual([]);
});
