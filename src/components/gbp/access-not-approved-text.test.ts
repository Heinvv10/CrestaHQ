// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { ACCESS_NOT_APPROVED_TEXT } from "@/lib/gbp/error-text";
import { ListingPicker } from "./listing-picker";
import { describeRun } from "./run-text";
import { HealthBanner } from "./sync-health";

/**
 * SP5 G4 — every place the GBP UI shows a provider failure names Google's
 * quota-0 refusal for what it is, in the one fixed sentence.
 */

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("access_not_approved wording", () => {
  it("the listing picker says it when the listings route refuses with that code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 502, json: async () => ({ code: "access_not_approved", error: "x" }) })));
    await act(async () => root.render(createElement(ListingPicker, { subAccountId: "sa1" })));
    expect(container.querySelector('[data-testid="gbp-picker-error"]')?.textContent).toContain(ACCESS_NOT_APPROVED_TEXT);
  });

  it("a failed sync run says it", () => {
    expect(describeRun({ status: "failed", errorKind: "access_not_approved", skipReason: null })).toBe(
      `Sync failed: ${ACCESS_NOT_APPROVED_TEXT} Cached reviews are kept.`,
    );
    expect(describeRun({ status: "failed", errorKind: "transient", skipReason: null })).toBe("Sync failed (transient). Cached reviews are kept.");
  });

  it("the error health banner says it", async () => {
    await act(async () =>
      root.render(createElement(HealthBanner, { health: "error", lastErrorKind: "access_not_approved", lastReconciliation: null, lastSuccessfulSyncAt: null })),
    );
    expect(container.querySelector('[data-testid="gbp-banner-error"]')?.textContent).toBe(ACCESS_NOT_APPROVED_TEXT);
  });
});
