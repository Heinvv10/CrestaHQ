// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

import { ListingPicker } from "./listing-picker";

/** What the admin is told when the server refuses a selection. */

let container: HTMLDivElement;
let root: Root;

const LOCATIONS = {
  truncated: true,
  accounts: [
    {
      name: "accounts/a1",
      accountName: "Fixture Group",
      locations: [{ name: "locations/l1", title: "Fixture Fibre", address: "1 Fixture Road", websiteUri: null, placeId: null, mapsUri: null }],
    },
  ],
};

beforeEach(() => {
  toasts.error.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT"
        ? { ok: false, status: 400, json: async () => ({ error: "x", code: "unverifiable_truncated" }) }
        : { ok: true, status: 200, json: async () => LOCATIONS },
    ),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("explains a selection that could not be verified because the account is too large", async () => {
  await act(async () => root.render(createElement(ListingPicker, { subAccountId: "sa1" })));
  await act(async () => (container.querySelector('input[type="radio"]') as HTMLInputElement).click());
  await act(async () => (container.querySelector('[data-testid="gbp-select-listing"]') as HTMLButtonElement).click());
  expect(toasts.error).toHaveBeenCalledTimes(1);
  expect(toasts.error.mock.calls[0][0]).toMatch(/too many listings to verify/);
});
