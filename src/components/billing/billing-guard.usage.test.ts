// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The workspace guard's usage states: none (children untouched), banner and
 * wall. Real BillingGuard and real usage-debt rules; only the two context
 * hooks and `fetch` are stubbed. NOT browser-verified: this is jsdom.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) => createElement("a", { href }, children as never),
}));
const ctx = vi.hoisted(() => ({
  sub: { value: null as Record<string, unknown> | null },
  isAdmin: { value: true },
  auth: { value: { agencyId: "ag1", agencyRole: null as string | null } },
}));
vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({ subAccount: ctx.sub.value, subAccountId: "sa1", loading: false, isAdmin: ctx.isAdmin.value }),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ctx.auth.value }));

import { BillingGuard } from "./billing-guard";

const DAY = 24 * 60 * 60 * 1000;
const fetchMock = vi.fn();
let container: HTMLDivElement;
let root: Root;

const overdue = (daysAgo: number, paywall: boolean | undefined) => ({
  chargeId: "usage_sa1_2026-09",
  since: new Date(Date.now() - daysAgo * DAY),
  amountCents: 5000,
  currency: "zar",
  usageMonth: "2026-09",
  paywall,
});
const setSub = (extra: Record<string, unknown>) => {
  ctx.sub.value = { id: "sa1", agencyId: "ag1", billing: null, ...extra };
};

beforeEach(() => {
  toast.error.mockReset();
  ctx.isAdmin.value = true;
  ctx.auth.value = { agencyId: "ag1", agencyRole: null };
  fetchMock.mockReset().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: "This charge is already paid." }) });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(createElement(BillingGuard, null, createElement("p", null, "WORKSPACE CONTENT"))));
}
const text = () => container.textContent ?? "";
const button = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label));

describe("none: nothing flagged", () => {
  it("renders the workspace untouched", async () => {
    setSub({});
    await render();
    expect(text()).toBe("WORKSPACE CONTENT");
  });

  it("a flag with an unreadable due date renders the workspace untouched (fails open)", async () => {
    setSub({ usageOverdue: { ...overdue(30, true), since: "not a date" } });
    await render();
    expect(text()).toBe("WORKSPACE CONTENT");
  });
});

describe("banner: overdue, inside the grace period", () => {
  it("shows the amount and month, keeps the workspace, counts down only when the wall is on", async () => {
    setSub({ usageOverdue: overdue(2, true) });
    await render();
    expect(text()).toContain("WORKSPACE CONTENT");
    expect(text()).toContain("Usage invoice overdue");
    expect(text()).toContain("September 2026");
    expect(text()).toMatch(/Access pauses in\s*5 days/);
    expect(button("Pay now")).toBeTruthy();
  });

  it("with the wall off the banner makes no promise to pause access", async () => {
    setSub({ usageOverdue: overdue(2, false) });
    await render();
    expect(text()).toContain("Usage invoice overdue");
    expect(text()).not.toContain("Access pauses");
  });

  it("a member who is not an admin sees the banner without a pay button", async () => {
    ctx.isAdmin.value = false;
    setSub({ usageOverdue: overdue(2, true) });
    await render();
    expect(text()).toContain("Usage invoice overdue");
    expect(button("Pay now")).toBeUndefined();
  });
});

describe("wall: past the grace period", () => {
  it("replaces the workspace when the agency has the wall on", async () => {
    setSub({ usageOverdue: overdue(20, true) });
    await render();
    expect(text()).not.toContain("WORKSPACE CONTENT");
    expect(text()).toContain("Usage invoice unpaid");
    expect(button("Pay & restore access")).toBeTruthy();
  });

  it("never walls when the wall is off, however old the debt: banner only", async () => {
    for (const paywall of [false, undefined]) {
      setSub({ usageOverdue: overdue(400, paywall) });
      await render();
      expect(text()).toContain("WORKSPACE CONTENT");
      expect(text()).not.toContain("Usage invoice unpaid");
      expect(text()).toContain("Usage invoice overdue");
    }
  });

  it("never walls the agency owner, who gets a slim notice and the workspace", async () => {
    ctx.auth.value = { agencyId: "ag1", agencyRole: "owner" };
    setSub({ usageOverdue: overdue(20, true) });
    await render();
    expect(text()).toContain("WORKSPACE CONTENT");
    expect(text()).toContain("unpaid past the grace period");
    expect(text()).not.toContain("Usage invoice unpaid");
  });

  it("a non-admin member is told to ask their admin", async () => {
    ctx.isAdmin.value = false;
    setSub({ usageOverdue: overdue(20, true) });
    await render();
    expect(text()).toContain("Ask your workspace admin");
    expect(button("Pay & restore access")).toBeUndefined();
  });
});

describe("paying", () => {
  it("posts to the in-app usage checkout route for the flagged charge, and shows the server's refusal", async () => {
    setSub({ usageOverdue: overdue(20, true) });
    await render();
    await act(async () => button("Pay & restore access")!.click());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sub-accounts/sa1/billing/usage-charges/usage_sa1_2026-09/checkout",
      { method: "POST" },
    );
    expect(toast.error).toHaveBeenCalledWith("This charge is already paid.");
  });
});
