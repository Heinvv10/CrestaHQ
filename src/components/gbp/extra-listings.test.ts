// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { ExtraListings } from "./extra-listings";

/**
 * "Additional listings" through the real picker, with only `fetch` stubbed:
 * Firestore's Listen stream can sit silent for ~30 s after a write, so the
 * card shows what the save's 200 stored, and the doc's next snapshot wins.
 */

let container: HTMLDivElement;
let root: Root;
let answerPut: (() => void) | null;
let putBody: Record<string, unknown>;
const fetchMock = vi.fn();

const loc = (name: string, title: string) => ({ name, title, address: "", websiteUri: null, placeId: null, mapsUri: null });
const LOCATIONS = { truncated: false, accounts: [{ name: "accounts/a1", accountName: "Group", locations: [loc("locations/main", "Main"), loc("locations/b", "B Fibre")] }] };
const B = { accountName: "accounts/a1", locationName: "locations/b", title: "B Fibre", address: "1 B Road" };

beforeEach(() => {
  answerPut = null;
  putBody = { ok: true, added: ["locations/b"], removed: [], listings: [B] };
  fetchMock.mockReset().mockImplementation((_url: string, init?: RequestInit) =>
    init?.method === "PUT"
      ? new Promise((resolve) => (answerPut = () => resolve({ ok: putBody.ok === true, status: putBody.ok ? 200 : 409, json: async () => putBody })))
      : Promise.resolve({ ok: true, status: 200, json: async () => LOCATIONS }),
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

const render = (extras: unknown) =>
  act(async () => root.render(createElement(ExtraListings, { subAccountId: "sa1", main: "locations/main", extras: extras as never, canEdit: true })));
const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const shown = () => Array.from(container.querySelectorAll('[data-testid="gbp-extra-listing"]')).map((li) => li.textContent);

async function tickBAndSave() {
  await act(async () => byTestId("gbp-manage-extra-listings").click());
  await act(async () => container.querySelector<HTMLInputElement>('input[value="accounts/a1|locations/b"]')!.click());
  await act(async () => byTestId("gbp-save-extra-listings").click());
}

it("shows a saved listing from the 200, before any snapshot carries it", async () => {
  await render(undefined);
  await tickBAndSave();
  await act(async () => answerPut!());
  expect(shown()).toEqual(["B Fibre1 B Road"]);
});

it("a snapshot landing while the save is in flight does not hide the answer", async () => {
  await render(undefined);
  await tickBAndSave();
  await render([]); // an unrelated write, from before the save committed
  await act(async () => answerPut!());
  expect(shown()).toEqual(["B Fibre1 B Road"]);
});

it("the doc's next snapshot wins over the answer", async () => {
  await render(undefined);
  await tickBAndSave();
  await act(async () => answerPut!());
  await render([{ ...B, title: "B Fibre (renamed)" }]);
  expect(shown()).toEqual(["B Fibre (renamed)1 B Road"]);
});

it("a refused save shows nothing new", async () => {
  // Even a refusal that carried listings must not be shown.
  putBody = { ok: false, code: "listing_shared", error: "Another workspace already manages that listing.", listings: [B] };
  await render(undefined);
  await tickBAndSave();
  await act(async () => answerPut!());
  expect(shown()).toEqual([]);
});
