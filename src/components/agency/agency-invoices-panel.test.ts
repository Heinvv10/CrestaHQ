// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingChargeResponse } from "@/types/billing";
import type { SubAccountDoc } from "@/types";

/**
 * Agency > Client billing > Invoices. Real panel and real filter rules;
 * `fetch` answers the list, re-send and waive calls. NOT browser-verified.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { AgencyInvoicesPanel } from "./agency-invoices-panel";

const DAY = 24 * 60 * 60 * 1000;
const iso = (daysFromNow: number) => new Date(Date.now() + daysFromNow * DAY).toISOString();
const charge = (id: string, patch: Partial<BillingChargeResponse>): BillingChargeResponse => ({
  id,
  subAccountId: "sa1",
  description: `Charge ${id}`,
  amountCents: 10000,
  currency: "zar",
  status: "pending",
  createdAt: iso(-20),
  paidAt: null,
  extraPaymentCount: 0,
  kind: "manual",
  usageMonth: null,
  dueAt: null,
  ...patch,
});

const CHARGES = [
  charge("overdue_usage", { kind: "usage", usageMonth: "2026-09", amountCents: 5000, dueAt: iso(-3), description: "Usage September 2026" }),
  charge("future_usage", { kind: "usage", usageMonth: "2026-10", amountCents: 2500, dueAt: iso(5) }),
  charge("paid_now", { status: "paid", paidAt: iso(0), amountCents: 30000 }),
  charge("waived", { status: "canceled", kind: "usage", amountCents: 700 }),
];
const SUBS = [{ id: "sa1", name: "Client One" }] as unknown as SubAccountDoc[];

const fetchMock = vi.fn();
let container: HTMLDivElement;
let root: Root;
let listResponse: { ok: boolean; status?: number; json: () => Promise<unknown> };

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  listResponse = { ok: true, json: async () => ({ charges: CHARGES }) };
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/agency/billing/charges") return listResponse;
    if (init?.method === "PATCH") return { ok: true, json: async () => ({ checkoutUrl: "https://app.example.com/pay/charge/tok" }) };
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => {}) } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}
async function render() {
  await act(async () => root.render(createElement(AgencyInvoicesPanel, { subs: SUBS })));
  await settle();
}
const text = () => container.textContent ?? "";
const chip = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith(label));
const rows = () => [...container.querySelectorAll("tbody tr")];

describe("the table and totals", () => {
  it("lists every charge with the client's name and a Usage tag on usage charges", async () => {
    await render();
    expect(rows()).toHaveLength(4);
    expect(text()).toContain("Client One");
    expect(rows()[0].textContent).toContain("Usage");
    expect(rows()[0].textContent).toContain("Past due");
  });

  it("totals stay per currency: outstanding, overdue and collected this month", async () => {
    await render();
    const stats = [...container.querySelectorAll(".grid > div")].map((d) => d.textContent ?? "");
    expect(stats[0]).toContain("Outstanding");
    expect(stats[0]).toContain("75.00 ZAR"); // 5000 + 2500
    expect(stats[1]).toContain("Past due");
    expect(stats[1]).toContain("50.00 ZAR");
    expect(stats[2]).toContain("Collected this month");
    expect(stats[2]).toContain("300.00 ZAR");
  });

  it("filter chips count and narrow: past due is past-due only, not due-in-the-future", async () => {
    await render();
    expect(chip("Past due")!.textContent).toContain("1");
    expect(chip("Outstanding")!.textContent).toContain("2");
    await act(async () => chip("Past due")!.click());
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain("Usage September 2026");
    await act(async () => chip("Canceled / waived")!.click());
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain("Waived");
  });
});

describe("actions", () => {
  it("re-sending a usage charge's link warns that the emailed link dies, then copies a fresh one", async () => {
    await render();
    await act(async () => (rows()[0].querySelector('button[aria-label="Copy a fresh payment link"]') as HTMLButtonElement).click());
    await settle();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("stops working"));
    const patch = fetchMock.mock.calls.find(([, i]) => (i as RequestInit)?.method === "PATCH")!;
    expect(patch[0]).toBe("/api/agency/sub-accounts/sa1/billing/charges/overdue_usage");
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({ action: "sendLink" });
    expect(toast.success).toHaveBeenCalled();
  });

  it("declining the confirm sends nothing", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    await render();
    await act(async () => (rows()[0].querySelector('button[aria-label="Copy a fresh payment link"]') as HTMLButtonElement).click());
    expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit)?.method === "PATCH")).toBe(false);
  });

  it("waiving a usage charge says it lifts the banner or paywall, DELETEs it and reloads the list", async () => {
    await render();
    await act(async () => (rows()[0].querySelector('button[aria-label="Waive this usage charge"]') as HTMLButtonElement).click());
    await settle();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("banner or paywall"));
    const del = fetchMock.mock.calls.find(([, i]) => (i as RequestInit)?.method === "DELETE")!;
    expect(del[0]).toBe("/api/agency/sub-accounts/sa1/billing/charges/overdue_usage");
    expect(toast.success).toHaveBeenCalledWith("Usage charge waived.");
    expect(fetchMock.mock.calls.filter(([u]) => u === "/api/agency/billing/charges")).toHaveLength(2);
  });

  it("paid and waived rows offer no actions", async () => {
    await render();
    expect(rows()[2].querySelectorAll("button")).toHaveLength(0);
    expect(rows()[3].querySelectorAll("button")).toHaveLength(0);
  });
});

describe("a truncated list", () => {
  it("warns that the totals may be incomplete, with the count shown", async () => {
    listResponse = { ok: true, json: async () => ({ charges: CHARGES, truncated: true }) };
    await render();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Showing 4 invoices");
    expect(text()).toContain("totals below may be incomplete");
  });

  it("says nothing when the list is complete", async () => {
    await render();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});

describe("failure", () => {
  it("a failed load shows a retry, not an empty table", async () => {
    listResponse = { ok: false, status: 500, json: async () => ({}) };
    await render();
    expect(text()).toContain("Couldn't load invoices");
    expect(rows()).toHaveLength(0);
  });

  it("no charges yet explains where they come from", async () => {
    listResponse = { ok: true, json: async () => ({ charges: [] }) };
    await render();
    expect(text()).toContain("No invoices yet");
    expect(text()).toContain("—");
  });
});
