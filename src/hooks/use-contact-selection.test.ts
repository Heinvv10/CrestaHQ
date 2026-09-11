// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useContactSelection } from "./use-contact-selection";

/**
 * Select-all means the VISIBLE rows — the filtered set — never the whole
 * workspace, and a selection only survives a filter change for rows that
 * are still visible. A bulk delete over "everything" because select-all
 * ignored the filter is the failure this guards.
 */
function mount(initialVisible: string[]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let latest: ReturnType<typeof useContactSelection> | null = null;
  let visible = initialVisible;
  function Probe() {
    latest = useContactSelection(visible);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const render = () => act(async () => root.render(createElement(Probe)));
  return {
    render,
    get hook() {
      return latest!;
    },
    setVisible: async (ids: string[]) => {
      visible = ids;
      await render();
    },
    unmount: async () => {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    },
  };
}

it("select-all selects only the visible ids", async () => {
  const m = mount(["a", "b"]);
  await m.render();
  try {
    await act(async () => m.hook.selectAll());
    expect([...m.hook.selected].sort()).toEqual(["a", "b"]);
    expect(m.hook.allSelected).toBe(true);
  } finally {
    await m.unmount();
  }
});

it("toggles single rows and clears", async () => {
  const m = mount(["a", "b", "c"]);
  await m.render();
  try {
    await act(async () => m.hook.toggle("b"));
    await act(async () => m.hook.toggle("c"));
    expect([...m.hook.selected].sort()).toEqual(["b", "c"]);
    expect(m.hook.allSelected).toBe(false);
    await act(async () => m.hook.toggle("b"));
    expect([...m.hook.selected]).toEqual(["c"]);
    await act(async () => m.hook.clear());
    expect(m.hook.selected.size).toBe(0);
  } finally {
    await m.unmount();
  }
});

it("drops rows that a filter change hides, keeps the ones still visible", async () => {
  const m = mount(["a", "b", "c"]);
  await m.render();
  try {
    await act(async () => m.hook.selectAll());
    await m.setVisible(["b", "c"]);
    expect([...m.hook.selected].sort()).toEqual(["b", "c"]);
    // Widening the filter again does not resurrect "a".
    await m.setVisible(["a", "b", "c"]);
    expect([...m.hook.selected].sort()).toEqual(["b", "c"]);
    expect(m.hook.allSelected).toBe(false);
  } finally {
    await m.unmount();
  }
});
