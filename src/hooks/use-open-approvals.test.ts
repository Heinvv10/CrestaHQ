// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/** The sidebar badge: one list-route request for pending + unsettled, none
 *  while the Agent API gate is off. */

vi.mock("next/navigation", () => ({ usePathname: () => "/sa/sa1/dashboard" }));
const { useOpenApprovalsCount } = await import("./use-open-approvals");

let latest = -1;
let root: Root;
const fetchMock = vi.fn();
function Probe({ sub, enabled }: { sub: string | null; enabled: boolean }) {
  latest = useOpenApprovalsCount(sub, enabled);
  return null;
}
async function render(sub: string | null, enabled: boolean) {
  await act(async () => {
    root.render(createElement(Probe, { sub, enabled }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  latest = -1;
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("counts the open rows from ONE list-route request", async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ proposals: [{ id: "a" }, { id: "b" }, { id: "c" }] })));
  await render("sa1", true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith("/api/sub-accounts/sa1/agent-proposals?status=open");
  expect(latest).toBe(3);
});

it("makes no request and shows 0 while the gate is off", async () => {
  await render("sa1", false);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(latest).toBe(0);
});

it("a failed request shows 0, not a stale number", async () => {
  fetchMock.mockResolvedValue(new Response("{}", { status: 500 }));
  await render("sa1", true);
  expect(latest).toBe(0);
});
