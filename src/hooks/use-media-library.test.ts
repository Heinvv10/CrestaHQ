// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/** A listener failure must reach the caller as `error`, not as an empty library. */

const m = vi.hoisted(() => ({
  listeners: [] as Array<{ next: (s: unknown) => void; error: (e: Error) => void }>,
}));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
vi.mock("firebase/firestore", () => ({
  collection: (_db: unknown, path: string) => path,
  orderBy: () => null,
  query: (path: string) => path,
  onSnapshot: (_q: unknown, next: (s: unknown) => void, error: (e: Error) => void) => {
    m.listeners.push({ next, error });
    return () => {};
  },
}));
import { useMediaLibrary } from "./use-media-library";

type Result = ReturnType<typeof useMediaLibrary>;
let container: HTMLDivElement;
let root: Root;
let seen: Result[] = [];

function Probe() {
  seen.push(useMediaLibrary("sa1"));
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  m.listeners.length = 0;
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

it("hydrates from both listeners", async () => {
  await act(async () => root.render(createElement(Probe)));
  expect(m.listeners).toHaveLength(2);
  await act(async () => {
    m.listeners[0].next({ docs: [{ id: "m1", data: () => ({ name: "Logo" }) }] });
    m.listeners[1].next({ docs: [] });
  });
  expect(seen.at(-1)).toMatchObject({ hydrated: true, error: null, assets: [{ id: "m1", name: "Logo" }] });
});

it("surfaces a denied listener as an error", async () => {
  await act(async () => root.render(createElement(Probe)));
  await act(async () => {
    m.listeners[1].next({ docs: [] });
    m.listeners[0].error(new Error("permission-denied"));
  });
  expect(seen.at(-1)?.error?.message).toBe("permission-denied");
});
