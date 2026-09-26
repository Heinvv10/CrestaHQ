// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Manage dialog's "Review auto-reply" checkbox (feature-gates.md step 5):
 * it reflects the stored gate, sends only that field when changed, and a
 * reopened dialog shows the saved value. The billing/usage sections (tested
 * elsewhere) and the toast are stubbed; `fetch` answers the PATCH.
 */

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/agency/sub-account-billing-section", () => ({ SubAccountBillingSection: () => null }));
vi.mock("@/components/agency/sub-account-usage-section", () => ({ SubAccountUsageSection: () => null }));

import { SubAccountManageDialog } from "./sub-account-manage-dialog";
import type { SubAccountDoc } from "@/types";

const fetchMock = vi.fn();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async (url: string) =>
    ({ ok: true, status: 200, json: async () => (url.endsWith("/feature-gates") ? { ok: true } : { metaConfigured: true }) }),
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

const sub = (extra: Record<string, unknown>) => ({ id: "sa1", agencyId: "ag1", name: "Fixture", ...extra }) as unknown as SubAccountDoc;

async function open(doc: SubAccountDoc, isOpen = true) {
  await act(async () => root.render(createElement(SubAccountManageDialog, { subAccount: doc, open: isOpen, onOpenChange: () => undefined })));
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}
function checkbox(): HTMLInputElement {
  const label = [...document.body.querySelectorAll("label")].find((l) => l.textContent?.includes("Review auto-reply"));
  if (!label) throw new Error("no Review auto-reply toggle");
  return label.querySelector("input[type=checkbox]") as HTMLInputElement;
}
const saveButton = () => [...document.body.querySelectorAll("button")].find((b) => /^Save/.test(b.textContent?.trim() ?? ""))!;
const patches = () =>
  fetchMock.mock.calls.filter(([u, i]) => String(u).endsWith("/feature-gates") && (i as RequestInit)?.method === "PATCH").map(([, i]) => JSON.parse(String((i as RequestInit).body)));

describe("Review auto-reply checkbox", () => {
  it("reads the stored gate (unset reads as off)", async () => {
    await open(sub({}));
    expect(checkbox().checked).toBe(false);
    await open(sub({}), false);
    await open(sub({ reviewsAutoReplyEnabledByAgency: true }));
    expect(checkbox().checked).toBe(true);
  });

  it("sends only this field when ticked, and reopening shows the saved value", async () => {
    await open(sub({ reviewsAiEnabledByAgency: true }));
    await act(async () => checkbox().click());
    await act(async () => saveButton().click());
    expect(patches()).toEqual([{ reviewsAutoReplyEnabled: true }]);
    // The list page re-renders with the saved doc; the dialog reopens on it.
    await open(sub({ reviewsAiEnabledByAgency: true }), false);
    await open(sub({ reviewsAiEnabledByAgency: true, reviewsAutoReplyEnabledByAgency: true }));
    expect(checkbox().checked).toBe(true);
  });
});
