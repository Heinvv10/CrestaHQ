// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The approvals page reads the SAME actionable set the sidebar badge counts
 * (`?status=open`) plus terminal rows separately, so an old pending/unsettled
 * row is never counted yet hidden. With the Agent API gate off it still
 * shows unsettled rows so a person can settle them.
 */

const ctx = vi.hoisted(() => ({ value: { subAccountId: "sa1", subAccount: { agentApiEnabledByAgency: true } as Record<string, unknown> | null } }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx.value }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) => createElement("a", { href }, children as never),
}));

const { default: ApprovalsPage } = await import("./page");

const row = (id: string, status: string, n: number) => ({
  id, capability: "complete_task", approval: "hard_delete", status, rev: `r${id}`,
  summary: `Row ${id}`, preview: [{ label: "Task", value: id }], createdAt: new Date(n).toISOString(), claimedAt: null,
});
const OLD_UNSETTLED = row("old_unsettled", "unsettled", 1);
const EXECUTED = Array.from({ length: 100 }, (_, i) => row(`done_${i}`, "executed", 1000 + i));
const byUrl: Record<string, unknown[]> = {
  "/api/sub-accounts/sa1/agent-proposals?status=open": [OLD_UNSETTLED],
  "/api/sub-accounts/sa1/agent-proposals?status=recent": EXECUTED,
  "/api/sub-accounts/sa1/agent-proposals?status=unsettled": [OLD_UNSETTLED],
  // The reviewer's probe: the unfiltered 100 newest are all executed.
  "/api/sub-accounts/sa1/agent-proposals": EXECUTED,
};
const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify({ proposals: byUrl[url] ?? [] })));

let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => {
    root.render(createElement(ApprovalsPage));
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("gate on", () => {
  beforeEach(() => {
    ctx.value = { subAccountId: "sa1", subAccount: { agentApiEnabledByAgency: true } };
  });

  it("reviewer's probe: an old unsettled row behind 100 newer executed rows is still shown", async () => {
    await render();
    expect(fetchMock.mock.calls.map(([u]) => u).sort()).toEqual([
      "/api/sub-accounts/sa1/agent-proposals?status=open",
      "/api/sub-accounts/sa1/agent-proposals?status=recent",
    ]);
    expect(document.querySelector('[data-testid="approval-old_unsettled"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Needs checking");
  });
});

describe("gate off", () => {
  it("with unsettled rows: a paused banner, the Needs checking section with mark actions, no Approve", async () => {
    ctx.value = { subAccountId: "sa1", subAccount: { agentApiEnabledByAgency: false } };
    await render();
    expect(fetchMock.mock.calls.map(([u]) => u)).toEqual(["/api/sub-accounts/sa1/agent-proposals?status=unsettled"]);
    expect(document.querySelector('[data-testid="approvals-paused"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="approval-old_unsettled"]')).not.toBeNull();
    const buttons = [...document.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toEqual(expect.arrayContaining(["It went out", "It did not go out"]));
    expect(buttons.some((t) => t?.includes("Approve"))).toBe(false);
  });

  it("with nothing unsettled: the locked notice", async () => {
    ctx.value = { subAccountId: "sa1", subAccount: { agentApiEnabledByAgency: false } };
    byUrl["/api/sub-accounts/sa1/agent-proposals?status=unsettled"] = [];
    await render();
    expect(document.body.textContent).toContain("Approvals are locked");
    byUrl["/api/sub-accounts/sa1/agent-proposals?status=unsettled"] = [OLD_UNSETTLED];
  });
});
