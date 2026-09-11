// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

/**
 * A dead smart-list stream (permission-denied, offline) must not leave the
 * page waiting forever: `lists` stays null, the ?list= effect never runs,
 * and a deep link silently shows "All" with nothing to say why. The error
 * handler has to mark the lists loaded AND tell the user.
 */
const m = vi.hoisted(() => ({
  onError: null as null | ((err: Error) => void),
  toastError: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: m.toastError, success: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: m.replace }),
  usePathname: () => "/sa/sa1/contacts",
}));
vi.mock("@/lib/firestore/smart-lists", () => ({
  subscribeToSmartLists: (
    _sa: string,
    _cb: unknown,
    onError: (err: Error) => void,
  ) => {
    m.onError = onError;
    return () => {};
  },
  createSmartList: vi.fn(),
  renameSmartList: vi.fn(),
  deleteSmartList: vi.fn(),
}));
import { useSmartLists } from "./use-smart-lists";

it("a failed subscription toasts and unblocks the deep-link fallback", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let latest: ReturnType<typeof useSmartLists> | null = null;
  function Probe() {
    latest = useSmartLists({ agencyId: "ag1", subAccountId: "sa1", uid: "u1" });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Probe)));
    expect(m.onError, "hook passed no error handler").not.toBeNull();

    // Deep link to a list that can never load.
    await act(async () => latest!.setActiveListId("missing"));
    expect(m.replace).not.toHaveBeenCalled(); // still waiting: correct so far

    await act(async () => m.onError!(new Error("permission-denied")));
    expect(m.toastError).toHaveBeenCalledWith("Couldn't load smart lists.");
    expect(latest!.lists).toEqual([]);
    // Lists now count as loaded, so the stale ?list= falls back to All.
    expect(m.replace).toHaveBeenCalledWith("/sa/sa1/contacts");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("saveList refuses without an agency or user and reports failure", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let latest: ReturnType<typeof useSmartLists> | null = null;
  function Probe() {
    latest = useSmartLists({ agencyId: null, subAccountId: "sa1", uid: null });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Probe)));
    await expect(latest!.saveList("VIP")).resolves.toBe(false);
    expect(m.toastError).toHaveBeenCalledWith("Could not save the list.");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
