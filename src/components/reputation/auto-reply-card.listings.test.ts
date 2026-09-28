// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The "Auto-reply" card with several listings (MULTI_LISTING_V1_PLAN.md
 * PR 6): one switch per listing by title (main's is the master switch), the
 * extras' switches saved as `listings`, a note that settings and caps are
 * shared. Rendered for real (jsdom); `fetch` answers with the route's shapes.
 */

import { AutoReplyCard } from "./auto-reply-card";

const API = "/api/sub-accounts/sa1/reputation/auto-reply";
const MODES = { 1: "approval", 2: "approval", 3: "approval", 4: "auto", 5: "auto" };
const MAIN = { locationName: "locations/main", title: "Blitz Fibre (Pty) Ltd", main: true, enabled: false, enabledAt: null };
const EXTRA = { locationName: "locations/gqeberha", title: "Blitz Fibre", main: false, enabled: false, enabledAt: null };
let state: Record<string, unknown>;
const fetchMock = vi.fn();
const json = (b: unknown, status = 200) => ({ ok: status < 400, status, json: async () => b });

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  state = {
    enabled: false, modes: MODES, includeBacklog: false, enabledAt: null, disabledReason: null,
    gatesOn: true, gate: null, available: true, running: true, dailyPostCap: 20, dailyDraftCap: 40,
    listings: [MAIN, EXTRA],
  };
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url !== API) throw new Error(`unexpected fetch ${url}`);
    if ((init?.method ?? "GET") === "GET") return json(state);
    const sent = JSON.parse(String(init?.body)) as { listings?: Record<string, boolean> };
    const listings = (state.listings as Array<typeof EXTRA>).map((l) =>
      l.main ? l : { ...l, enabled: sent.listings?.[l.locationName] ?? l.enabled });
    return json({ reviewsAutoReply: { ...sent, enabledAt: null, disabledReason: null, listings } });
  });
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

async function render(isAdmin = true) {
  await act(async () => root.render(createElement(AutoReplyCard, { subAccountId: "sa1", isAdmin })));
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}
const byId = <T extends HTMLElement = HTMLInputElement>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`);
const extraRow = () => container.querySelector<HTMLElement>(`[data-testid="rep-settings-autoreply-listing"][data-location="${EXTRA.locationName}"]`)!;
const extraBox = () => extraRow().querySelector<HTMLInputElement>("input")!;
const puts = () => fetchMock.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === "PUT").map(([, i]) => JSON.parse(String(i.body)));

describe("several listings", () => {
  it("one switch per listing by title; main's is the master switch; caps are said to be shared", async () => {
    await render();
    expect(byId<HTMLElement>("rep-settings-autoreply-enabled")!.closest("label")!.textContent).toBe(MAIN.title);
    expect(extraRow().textContent).toBe(EXTRA.title);
    expect(extraBox().checked).toBe(false);
    expect(byId("rep-settings-autoreply-caps-shared")?.textContent).toContain("shared across listings");
  });

  it("an admin switches only the extra on and saves: the body carries `listings`, main stays off", async () => {
    await render();
    await act(async () => extraBox().click());
    expect(extraBox().checked).toBe(true);
    await act(async () => byId<HTMLElement>("rep-settings-autoreply-save")!.click());
    expect(puts()).toEqual([{ enabled: false, includeBacklog: false, modes: MODES, listings: { [EXTRA.locationName]: true } }]);
    expect(byId("rep-settings-autoreply-saved")).not.toBeNull();
    expect(extraBox().checked).toBe(true);
    expect(byId("rep-settings-autoreply-enabled")!.checked).toBe(false);
  });

  it("a member cannot switch a listing", async () => {
    await render(false);
    expect(extraBox().disabled).toBe(true);
  });
});

describe("one listing", () => {
  it("no listing rows, no shared note, and the body has no `listings`", async () => {
    state = { ...state, listings: [MAIN] };
    await render();
    expect(container.querySelector('[data-testid="rep-settings-autoreply-listing"]')).toBeNull();
    expect(byId("rep-settings-autoreply-caps-shared")).toBeNull();
    expect(byId<HTMLElement>("rep-settings-autoreply-enabled")!.closest("label")!.textContent).toBe("Auto-reply to Google reviews");
    await act(async () => byId<HTMLElement>("rep-settings-autoreply-save")!.click());
    expect(puts()).toEqual([{ enabled: false, includeBacklog: false, modes: MODES }]);
  });
});
