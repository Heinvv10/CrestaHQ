// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: m.toastError, success: vi.fn() } }));
import { useSubAccountMembers } from "./use-sub-account-members";

const roster = [{ uid: "m1", displayName: "Mia", email: "", role: "admin" }];

function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let latest: ReturnType<typeof useSubAccountMembers> | null = null;
  function Probe() {
    latest = useSubAccountMembers("sa1");
    return null;
  }
  const root = createRoot(document.createElement("div"));
  return {
    render: () => act(async () => root.render(createElement(Probe))),
    get hook() {
      return latest!;
    },
    unmount: () => act(async () => root.unmount()),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  m.toastError.mockReset();
});

it("loads the roster, then keeps it and toasts when a refetch fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ members: roster }), { status: 200 })),
  );
  const first = mount();
  await first.render();
  expect(first.hook.members).toEqual(roster);
  expect(m.toastError).not.toHaveBeenCalled();
  await first.unmount();

  // A later mount whose fetch 500s must not fall back to "Unassigned only".
  vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
  const second = mount();
  await second.render();
  expect(second.hook.members).toEqual(roster);
  expect(m.toastError).toHaveBeenCalledWith("Couldn't load the team list.");
  await second.unmount();
});
