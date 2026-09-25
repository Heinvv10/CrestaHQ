// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/** The sidebar badge: one list-route request for pending + unsettled, none
 *  while the Agent API gate is off. */

let pathname = "/sa/sa1/dashboard";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
const { useOpenApprovalsCount } = await import("./use-open-approvals");

let latest = -1;
let root: Root;
const fetchMock = vi.fn();
type Mode = "open" | "unsettled" | null;
function Probe({ sub, mode }: { sub: string | null; mode: Mode }) {
  latest = useOpenApprovalsCount(sub, mode);
  return null;
}
async function render(sub: string | null, mode: Mode) {
  await act(async () => {
    root.render(createElement(Probe, { sub, mode }));
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
  await render("sa1", "open");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith("/api/sub-accounts/sa1/agent-proposals?status=open");
  expect(latest).toBe(3);
});

it("gate off: asks only for unsettled rows", async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ proposals: [{ id: "u" }] })));
  await render("sa1", "unsettled");
  expect(fetchMock).toHaveBeenCalledWith("/api/sub-accounts/sa1/agent-proposals?status=unsettled");
  expect(latest).toBe(1);
});

it("makes no request and shows 0 while the gate is unknown", async () => {
  await render("sa1", null);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(latest).toBe(0);
});

it("a failed request after a good one shows 0, not the stale number", async () => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ proposals: [{ id: "a" }, { id: "b" }] })));
  await render("sa1", "open");
  expect(latest).toBe(2);
  fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
  pathname = "/sa/sa1/contacts";
  await render("sa1", "open");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(latest).toBe(0);
});
