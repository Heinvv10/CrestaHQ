// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Manage dialog's usage section with the rebilling card: until G2 adds
 * a charge path, the copy never says a client is "rebilled" or charged.
 * Real component; `fetch` answers the usage GET and the feature-gates PATCH.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) => createElement("a", { href }, children as never),
}));

import { SubAccountUsageSection } from "./sub-account-usage-section";

const fetchMock = vi.fn();
let container: HTMLDivElement;
let root: Root;

function usage(rebilling: { active: boolean; agency: boolean; client: boolean; previewCents: number | null }) {
  return {
    usage: [{ month: "2026-10", emailsSent: 0, smsSegments: 120, whatsappMessages: 0, aiTokens: 0, voiceSeconds: 0 }],
    quotas: { smsSegmentsPerMonth: 100 },
    rates: { smsSegmentCents: 50 },
    overage: { perUnit: { smsSegments: { overUnits: 20, cents: 1000 } }, totalCents: 1000 },
    currency: "zar",
    quotaSource: "workspace",
    rebilling,
  };
}

let current = usage({ active: false, agency: true, client: false, previewCents: null });

beforeEach(() => {
  toast.success.mockReset();
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) =>
    ({
      ok: true,
      status: 200,
      json: async () => (init?.method === "PATCH" ? { ok: true } : current),
    }),
  );
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

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}
async function render() {
  await act(async () => root.render(createElement(SubAccountUsageSection, { subAccountId: "sa1" })));
  await settle();
}
const text = () => container.textContent ?? "";
const button = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

describe("rebilling card copy before G2", () => {
  it("both switches on: 'Rebilling on, no charges yet', never 'Rebilled'", async () => {
    current = usage({ active: true, agency: true, client: true, previewCents: 1000 });
    await render();
    expect(text()).toContain("Rebilling on, no charges yet");
    expect(text()).not.toMatch(/Rebilled/);
    expect(text()).toContain("Not charged yet");
  });

  it("switching on: the confirm says no charges, the toast says no charges yet", async () => {
    current = usage({ active: false, agency: true, client: false, previewCents: null });
    await render();
    await act(async () => button("Turn rebilling on")!.click());
    expect(text()).toContain("No charges are created yet");
    await act(async () => button("Yes, turn it on")!.click());
    await settle();
    expect(toast.success).toHaveBeenCalledWith("Rebilling on for this client, no charges yet.");
    const patch = fetchMock.mock.calls.find(([, i]) => (i as RequestInit)?.method === "PATCH")!;
    expect(String(patch[0])).toBe("/api/agency/sub-accounts/sa1/feature-gates");
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({ usageRebillingEnabled: true });
  });

  it("the existing overage line shows whatever the switches say", async () => {
    current = usage({ active: false, agency: false, client: false, previewCents: null });
    await render();
    expect(text()).toContain("Overage accruing this month");
    expect(text()).not.toContain("Usage charge this month (est.)");
  });
});
