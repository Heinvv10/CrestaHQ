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

const extra = (locationName: string, title: string) => ({ accountName: "accounts/a1", locationName, title });
const C = extra("locations/c", "C Fibre");

async function render(onClose = vi.fn(), selected = [C]) {
  await act(async () =>
    root.render(createElement(ListingPicker, { subAccountId: "sa1", mode: "multi", main: "locations/main", selected, onClose })),
  );
  return onClose;
}
const putBodies = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT").map(([, init]) => JSON.parse(init.body));
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
    expected: [{ accountName: "accounts/a1", locationName: "locations/c" }],
  });
  expect(toasts.success).toHaveBeenCalledWith("Additional listings saved.");
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("unticking every box saves an empty set (removes them all)", async () => {
  await render();
  await act(async () => boxes()[1].click());
  await act(async () => save().click());
  const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
  expect(JSON.parse(put[1].body)).toEqual({ listings: [], expected: [{ accountName: "accounts/a1", locationName: "locations/c" }] });
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
    await render(vi.fn(), []);
    expect(container.querySelector('[data-testid="gbp-picker-empty"]')?.textContent).toMatch(/any other Business Profile locations/);
  } finally {
    LOCATIONS.accounts[0].locations.push(loc("locations/b", "B Fibre"), loc("locations/c", "C Fibre"));
  }
});

it("listings_changed: says so, re-seeds from the live listings and sends those as expected next", async () => {
  putResponse = { ok: false, status: 409, body: { error: "x", code: "listings_changed" } };
  const onClose = await render();
  // The live doc changes while the picker is open: C removed, B added elsewhere.
  await render(onClose, [extra("locations/b", "B Fibre")]);
  expect(boxes().map((b) => b.checked)).toEqual([false, true]);
  await act(async () => save().click());
  expect(toasts.error).toHaveBeenCalledWith("Listings changed — reopened with the latest");
  expect(onClose).not.toHaveBeenCalled();
  expect(boxes().map((b) => [b.value, b.checked])).toEqual([
    ["accounts/a1|locations/b", true],
    ["accounts/a1|locations/c", false],
  ]);
  putResponse = { ok: true, status: 200, body: { ok: true } };
  await act(async () => save().click());
  expect(putBodies().at(-1)).toEqual({
    listings: [{ accountName: "accounts/a1", locationName: "locations/b" }],
    expected: [{ accountName: "accounts/a1", locationName: "locations/b" }],
  });
});

it("an extra missing from the walk is shown, labelled, and can be unticked", async () => {
  await render(vi.fn(), [C, extra("locations/gone", "Gone Fibre")]);
  const row = container.querySelector('[data-testid="gbp-location-missing-0"]')!;
  expect(row.textContent).toContain("Gone Fibre");
  expect(row.textContent).toContain("not visible in this Google connection");
  const box = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(box.checked).toBe(true);
  await act(async () => box.click());
  await act(async () => save().click());
  expect(putBodies().at(-1)).toEqual({
    listings: [{ accountName: "accounts/a1", locationName: "locations/c" }],
    expected: [
      { accountName: "accounts/a1", locationName: "locations/c" },
      { accountName: "accounts/a1", locationName: "locations/gone" },
    ],
  });
});
