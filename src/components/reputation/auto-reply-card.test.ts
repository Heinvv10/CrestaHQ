// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Reputation → Settings "Auto-reply" card (AUTO_REPLY_V1_PLAN.md, PR 1 + PR 3).
 * Every state rendered for real (jsdom); `fetch` is stubbed with the route's
 * response shapes.
 */

import { AUTO_REPLY_UI_ENABLED, AutoReplyCard } from "./auto-reply-card";

const API = "/api/sub-accounts/sa1/reputation/auto-reply";
const MODES = { 1: "approval", 2: "approval", 3: "approval", 4: "auto", 5: "auto" };
let state: Record<string, unknown>;
let putStatus: number;
let putRefusal: Record<string, string>;
const fetchMock = vi.fn();
const json = (b: unknown, status = 200) => ({ ok: status < 400, status, json: async () => b });

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  state = {
    enabled: false, modes: MODES, includeBacklog: false, enabledAt: null, disabledReason: null,
    gatesOn: true, gate: null, available: true, running: true, dailyPostCap: 20, dailyDraftCap: 40,
  };
  putStatus = 200;
  putRefusal = { code: "not_available", error: "Review auto-reply is not available yet." };
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url !== API) throw new Error(`unexpected fetch ${url}`);
    if ((init?.method ?? "GET") === "GET") return json(state);
    if (putStatus >= 400) return json(putRefusal, putStatus);
    return json({ reviewsAutoReply: { ...JSON.parse(String(init?.body)), enabledAt: null, disabledReason: null } });
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
const click = async (id: string) => act(async () => byId<HTMLElement>(id)!.click());
const puts = () => fetchMock.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === "PUT").map(([, i]) => JSON.parse(String(i.body)));

it("is shown since PR 3", () => {
  expect(AUTO_REPLY_UI_ENABLED).toBe(true);
});

describe("the card", () => {
  it("shows the defaults, the texted-review note and the caps from the route", async () => {
    await render();
    expect(byId("rep-settings-autoreply-enabled")!.checked).toBe(false);
    for (const star of ["1", "2", "3"]) expect(byId(`rep-settings-autoreply-star-${star}-approval`)!.checked).toBe(true);
    for (const star of ["4", "5"]) expect(byId(`rep-settings-autoreply-star-${star}-auto`)!.checked).toBe(true);
    expect(byId("rep-settings-autoreply-backlog")!.checked).toBe(false);
    expect(byId("rep-settings-autoreply-texted-note")?.textContent).toBe("Reviews with written text always wait for approval.");
    expect(byId("rep-settings-autoreply-caps")?.textContent).toBe("At most 20 auto-posted replies and 40 auto-drafts a day.");
  });

  it("an admin saves the switch, every star and the backlog option in one PUT", async () => {
    await render();
    await click("rep-settings-autoreply-enabled");
    await click("rep-settings-autoreply-star-3-auto");
    await click("rep-settings-autoreply-backlog");
    await click("rep-settings-autoreply-save");
    expect(puts()).toEqual([{ enabled: true, includeBacklog: true, modes: { ...MODES, 3: "auto" } }]);
    expect(byId("rep-settings-autoreply-saved")).not.toBeNull();
  });

  it("shows the server's refusal inline", async () => {
    putStatus = 409;
    await render();
    await click("rep-settings-autoreply-enabled");
    await click("rep-settings-autoreply-save");
    expect(byId("rep-settings-autoreply-save-error")?.textContent).toBe("Review auto-reply is not available yet.");
  });

  it("while the engine is unavailable the switch cannot be turned on", async () => {
    state = { ...state, available: false };
    await render();
    expect(byId("rep-settings-autoreply-enabled")!.disabled).toBe(true);
    expect(byId("rep-settings-autoreply-unavailable")).not.toBeNull();
  });

  it("a member sees the settings but cannot change or save them", async () => {
    await render(false);
    expect(byId("rep-settings-autoreply-enabled")!.disabled).toBe(true);
    expect(byId("rep-settings-autoreply-star-1-auto")!.disabled).toBe(true);
    expect(byId("rep-settings-autoreply-save")).toBeNull();
    expect(byId("rep-settings-autoreply-readonly")).not.toBeNull();
  });

  it.each([
    ["gate_off", "Google Business Profile"],
    ["ai_gate_off", "Reviews AI"],
    ["auto_reply_gate_off", "review auto-reply"],
  ])("gate %s off: locked, says which, no controls", async (gate, names) => {
    state = { ...state, gatesOn: false, gate };
    await render();
    const locked = byId<HTMLElement>("rep-settings-autoreply-locked")!;
    expect(locked.textContent?.trim()).toBe(`Auto-reply is locked: your agency has not enabled ${names} for this sub-account.`);
    expect(byId("rep-settings-autoreply-enabled")).toBeNull();
    expect(byId("rep-settings-autoreply-save")).toBeNull();
  });

  it("gates off without a known gate name still locks (fails closed)", async () => {
    state = { ...state, gatesOn: false, gate: "something-new" };
    await render();
    expect(byId<HTMLElement>("rep-settings-autoreply-locked")?.dataset.gate).toBe("auto_reply_gate_off");
    expect(byId("rep-settings-autoreply-enabled")).toBeNull();
  });

  it("kill switch off: says auto-reply isn't running here, and still saves", async () => {
    state = { ...state, running: false };
    await render();
    expect(byId("rep-settings-autoreply-not-running")?.textContent).toContain("Auto-reply isn't running on this deployment yet");
    await click("rep-settings-autoreply-enabled");
    await click("rep-settings-autoreply-save");
    expect(puts()).toHaveLength(1);
  });

  it("kill switch on: no not-running note", async () => {
    await render();
    expect(byId("rep-settings-autoreply-not-running")).toBeNull();
  });

  it("switched off by a listing change: says so; switching on and saving clears it", async () => {
    state = { ...state, disabledReason: "listing_changed" };
    await render();
    expect(byId("rep-settings-autoreply-listing-changed")?.textContent).toBe(
      "Switched off because the Google listing changed — switch on again to resume.",
    );
    await click("rep-settings-autoreply-enabled");
    await click("rep-settings-autoreply-save");
    expect(puts()).toEqual([{ enabled: true, includeBacklog: false, modes: MODES }]);
    expect(byId("rep-settings-autoreply-listing-changed")).toBeNull();
  });

  it("no note when the admin switched it off themselves", async () => {
    await render();
    expect(byId("rep-settings-autoreply-listing-changed")).toBeNull();
  });

  it.each([
    [409, "no_listing", "Choose a Google Business listing before turning auto-reply on."],
    [409, "listing_shared", "Another sub-account uses this Google listing — auto-reply can't be switched on here."],
    [403, "auto_reply_gate_off", "Review auto-reply is not enabled for this sub-account."],
  ])("a %s %s refusal shows inline and nothing is marked saved", async (status, code, error) => {
    putStatus = status;
    putRefusal = { code, error };
    await render();
    await click("rep-settings-autoreply-enabled");
    await click("rep-settings-autoreply-save");
    expect(byId("rep-settings-autoreply-save-error")?.textContent).toBe(error);
    expect(byId("rep-settings-autoreply-saved")).toBeNull();
  });

  it("a failed load says so", async () => {
    fetchMock.mockImplementation(async () => json({ error: "x" }, 500));
    await render();
    expect(byId("rep-settings-autoreply-error")).not.toBeNull();
  });
});
