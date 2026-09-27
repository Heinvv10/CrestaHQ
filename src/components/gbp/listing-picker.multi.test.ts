// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

import { ListingPicker } from "./listing-picker";

/** The picker in `multi` mode: the "Additional listings" multi-select. */

let container: HTMLDivElement;
let root: Root;
let putResponse: { ok: boolean; status: number; body: Record<string, unknown> };
const fetchMock = vi.fn();

const loc = (name: string, title: string) => ({ name, title, address: "", websiteUri: null, placeId: null, mapsUri: null });
const LOCATIONS = {
  truncated: false,
  accounts: [
    {
      name: "accounts/a1",
      accountName: "Fixture Group",
      locations: [loc("locations/main", "Main Fibre"), loc("locations/b", "B Fibre"), loc("locations/c", "C Fibre")],
    },
  ],
};

beforeEach(() => {
  toasts.error.mockReset();
  toasts.success.mockReset();
  putResponse = { ok: true, status: 200, body: { ok: true } };
  fetchMock.mockReset().mockImplementation(async (_url: string, init?: RequestInit) =>
    init?.method === "PUT"
      ? { ok: putResponse.ok, status: putResponse.status, json: async () => putResponse.body }
      : { ok: true, status: 200, json: async () => LOCATIONS },
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

async function render(onClose = vi.fn()) {
  await act(async () =>
    root.render(
      createElement(ListingPicker, { subAccountId: "sa1", mode: "multi", main: "locations/main", selected: ["accounts/a1|locations/c"], onClose }),
    ),
  );
  return onClose;
}
const boxes = () => Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
const save = () => container.querySelector<HTMLButtonElement>('[data-testid="gbp-save-extra-listings"]')!;

it("offers every listing but the main, as checkboxes, with the connected extras ticked", async () => {
  await render();
  expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  expect(boxes().map((b) => [b.value, b.checked])).toEqual([
    ["accounts/a1|locations/b", false],
    ["accounts/a1|locations/c", true],
  ]);
  expect(container.textContent).not.toContain("Main Fibre");
  expect(save().textContent).toBe("Save additional listings");
});

it("saves the whole set — connected extras first, then new ticks — to the extra-listings route", async () => {
  const onClose = await render();
  await act(async () => boxes()[0].click());
  await act(async () => save().click());
  const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
  expect(put[0]).toBe("/api/sub-accounts/sa1/google/extra-listings");
  expect(JSON.parse(put[1].body)).toEqual({
    listings: [
      { accountName: "accounts/a1", locationName: "locations/c" },
      { accountName: "accounts/a1", locationName: "locations/b" },
    ],
  });
  expect(toasts.success).toHaveBeenCalledWith("Additional listings saved.");
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("unticking every box saves an empty set (removes them all)", async () => {
  await render();
  await act(async () => boxes()[1].click());
  await act(async () => save().click());
  const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
  expect(JSON.parse(put[1].body)).toEqual({ listings: [] });
});

it("explains a listing another workspace already manages", async () => {
  putResponse = { ok: false, status: 409, body: { error: "x", code: "listing_shared" } };
  const onClose = await render();
  await act(async () => boxes()[0].click());
  await act(async () => save().click());
  expect(toasts.error).toHaveBeenCalledWith("Another workspace already manages that listing.");
  expect(onClose).not.toHaveBeenCalled();
});

it("says so when the main is the only listing", async () => {
  LOCATIONS.accounts[0].locations.splice(1);
  try {
    await render();
    expect(container.querySelector('[data-testid="gbp-picker-empty"]')?.textContent).toMatch(/any other Business Profile locations/);
  } finally {
    LOCATIONS.accounts[0].locations.push(loc("locations/b", "B Fibre"), loc("locations/c", "C Fibre"));
  }
});
