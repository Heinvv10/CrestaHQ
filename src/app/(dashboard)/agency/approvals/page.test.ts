// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /agency/approvals (A5): owner only; every top-level return inside the
 * max-w-5xl shell; rows grouped by target with preview lines, class, key
 * prefix and age; "Approve all (N)" only over batch-eligible rows, posting
 * each to the agency decide route, and saying how many it skips.
 */

const auth = vi.hoisted(() => ({ value: { agencyRole: "owner" as string, loading: false } }));
const agency = vi.hoisted(() => ({ value: { agentApiEnabled: true, resolved: true } }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth.value }));
vi.mock("@/hooks/use-agency", () => ({ useAgency: () => agency.value }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) => createElement("a", { href }, children as never),
}));

const { default: Page } = await import("./page");

const row = (id: string, approval: string, target: string, keyCreated: boolean, status = "pending") => ({
  id, capability: "x", approval, status, rev: `r_${id}`, summary: `Row ${id}`,
  preview: [{ label: "What", value: `preview ${id}` }], createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  claimedAt: null, subAccountId: approval === "gate_change" ? null : target, targetSubAccountId: target,
  targetName: target === "kc" ? "Key Co" : "Old Co", keyCreated, keyPrefix: "agcy1234",
});
const ACTIVATE = row("act", "workflow_activate", "kc", true);
const GATE = row("gate", "gate_change", "kc", true);
const SEND = row("send", "outbound", "old", false);
let byUrl: Record<string, unknown[] | "error"> = {};
/** A GET whose response is held until the promise resolves. */
let holds: Record<string, Promise<void>> = {};
const posts: Array<[string, unknown]> = [];
let decideStatus = 200;
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.method === "POST") {
    posts.push([url, JSON.parse(String(init.body))]);
    return new Response(JSON.stringify({ status: decideStatus === 202 ? "unsettled" : "executed" }), { status: decideStatus });
  }
  await holds[url];
  const rows = byUrl[url];
  return rows === "error"
    ? new Response(JSON.stringify({ error: "Boom" }), { status: 500 })
    : new Response(JSON.stringify({ proposals: rows ?? [] }));
});

let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => {
    root.render(createElement(Page));
    await new Promise((r) => setTimeout(r, 0));
  });
}
const shell = () => container.querySelector('[data-testid="agency-approvals"]');
const text = () => container.textContent ?? "";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  posts.length = 0;
  decideStatus = 200;
  holds = {};
  auth.value = { agencyRole: "owner", loading: false };
  agency.value = { agentApiEnabled: true, resolved: true };
  byUrl = {
    "/api/agency/agent-proposals?status=open": [ACTIVATE, GATE, SEND],
    "/api/agency/agent-proposals?status=recent": [],
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("the queue", () => {
  it("groups rows by target with preview, class, key prefix and age", async () => {
    await render();
    expect(fetchMock.mock.calls.map(([u]) => u).sort()).toEqual([
      "/api/agency/agent-proposals?status=open",
      "/api/agency/agent-proposals?status=recent",
    ]);
    const kc = container.querySelector('[data-testid="approval-group-kc"]')!;
    expect(kc.textContent).toContain("Key Co");
    expect(kc.querySelector('[data-testid="approval-act"]')).not.toBeNull();
    expect(kc.querySelector('[data-testid="approval-gate"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="approval-group-old"] [data-testid="approval-send"]')).not.toBeNull();
    const meta = container.querySelector('[data-testid="approval-gate"] [data-testid="approval-meta"]')!.textContent;
    expect(meta).toContain("Feature gate");
    expect(meta).toContain("agcy1234");
    expect(meta).toContain("2h ago");
    expect(text()).toContain("preview gate");
  });

  it("Approve all covers the eligible row only, through the agency route, and names what it skips", async () => {
    await render();
    const button = container.querySelector('[data-testid="approve-all"]') as HTMLButtonElement;
    expect(button.textContent).toContain("Approve all (1)");
    expect(container.querySelector('[data-testid="approve-all-bar"]')!.textContent).toContain(
      "skips 2 that need their own click"
    );
    await act(async () => {
      button.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(posts).toEqual([["/api/agency/agent-proposals/act", { decision: "approve", rev: "r_act" }]]);
  });

  it("Approve all reports a 202 as not known yet, never as approved", async () => {
    const { toast } = await import("sonner");
    decideStatus = 202;
    await render();
    vi.mocked(toast.warning).mockClear();
    vi.mocked(toast.success).mockClear();
    await act(async () => {
      (container.querySelector('[data-testid="approve-all"]') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith("Approved 0. 1 still running, so the outcome isn't known yet; check back soon.");
  });

  it("Approve all skips a row that stopped being eligible after the page loaded", async () => {
    await render();
    expect(container.querySelector('[data-testid="approve-all"]')!.textContent).toContain("Approve all (1)");
    // A person edited the target meanwhile: it is no longer key-created.
    byUrl["/api/agency/agent-proposals?status=open"] = [{ ...ACTIVATE, keyCreated: false }, GATE, SEND];
    await act(async () => {
      (container.querySelector('[data-testid="approve-all"]') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(posts).toEqual([]);
  });

  it("a row's own Approve posts to the agency route", async () => {
    await render();
    const card = container.querySelector('[data-testid="approval-gate"]')!;
    const approve = [...card.querySelectorAll("button")].find((b) => b.textContent?.includes("Approve"))!;
    await act(async () => {
      approve.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(posts).toEqual([["/api/agency/agent-proposals/gate", { decision: "approve", rev: "r_gate" }]]);
  });
});

describe("the agency switch, on a hard load", () => {
  it("waits for the agency doc: no request and no 'locked' state until it resolves, then open + recent only", async () => {
    agency.value = { agentApiEnabled: false, resolved: false };
    await render();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(text()).not.toContain("Approvals are locked");
    expect(shell()?.className).toContain("max-w-5xl");
    agency.value = { agentApiEnabled: true, resolved: true };
    await render();
    expect(fetchMock.mock.calls.map(([u]) => u).sort()).toEqual([
      "/api/agency/agent-proposals?status=open",
      "/api/agency/agent-proposals?status=recent",
    ]);
    expect(text()).toContain("Waiting for approval");
    expect(container.querySelector('[data-testid="approval-act"]')).not.toBeNull();
  });

  it("a stale load answering last never replaces the current one", async () => {
    let release!: () => void;
    holds["/api/agency/agent-proposals?status=unsettled"] = new Promise((r) => (release = r));
    agency.value = { agentApiEnabled: false, resolved: true };
    await render(); // asks for unsettled; its answer is held
    agency.value = { agentApiEnabled: true, resolved: true };
    await render(); // open + recent answer first
    expect(container.querySelector('[data-testid="approval-act"]')).not.toBeNull();
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(text()).toContain("Waiting for approval");
    expect(container.querySelector('[data-testid="approval-act"]')).not.toBeNull();
    expect(text()).not.toContain("Approvals are locked");
  });
});

describe("every top-level return sits in the max-w-5xl shell", () => {
  const states: Array<[string, () => void, string]> = [
    ["auth loading", () => (auth.value = { agencyRole: "owner", loading: true }), ""],
    ["not the owner", () => (auth.value = { agencyRole: "admin", loading: false }), "available to the agency owner"],
    ["load error", () => (byUrl["/api/agency/agent-proposals?status=open"] = "error"), "Boom"],
    ["switch off, nothing unsettled", () => (agency.value = { agentApiEnabled: false, resolved: true }), "Approvals are locked"],
    ["switch off, unsettled", () => {
      agency.value = { agentApiEnabled: false, resolved: true };
      byUrl["/api/agency/agent-proposals?status=unsettled"] = [row("u", "outbound", "old", false, "unsettled")];
    }, "Needs checking"],
    ["empty", () => (byUrl["/api/agency/agent-proposals?status=open"] = []), "Nothing to approve"],
    ["rows", () => undefined, "Waiting for approval"],
  ];
  it.each(states)("%s", async (_label, arrange, expected) => {
    arrange();
    await render();
    expect(shell()?.className).toContain("max-w-5xl");
    expect(text()).toContain(expected);
  });

  it("a non-owner never asks the list route", async () => {
    auth.value = { agencyRole: "admin", loading: false };
    await render();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
