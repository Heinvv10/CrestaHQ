// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reputation → Settings (SP5 c, ledger S1/R6): the existing review-request
 * section mounted as it is, plus the "Reviews AI" card with the reply
 * guidelines. Every state rendered for real (jsdom); `fetch`, the context and
 * the (separately tested) review-request section are stubbed.
 */

const ctx = vi.hoisted(() => ({ subAccountId: "sa1", isAdmin: true, loading: false, subAccount: {} as Record<string, unknown> | null }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx }));
vi.mock("@/components/settings/sub-account-google-review-section", () => ({
  SubAccountGoogleReviewSection: () => createElement("section", { "data-testid": "review-request-section" }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => createElement("a", { href, ...rest }, children),
}));

import { ReputationSettings } from "./settings";

const API = "/api/sub-accounts/sa1/reputation/ai-settings";
let state: Record<string, unknown>;
let putStatus: number;
const fetchMock = vi.fn();
const json = (b: unknown, status = 200) => ({ ok: status < 400, status, json: async () => b });

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  ctx.isAdmin = true;
  ctx.loading = false;
  ctx.subAccount = { googleEnabledByAgency: true };
  state = { enabled: true, configured: true, replyGuidelines: "Sign off as The Fixture Team.", updatedAt: "2026-09-14T08:00:00.000Z" };
  putStatus = 200;
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url !== API) throw new Error(`unexpected fetch ${url}`);
    if ((init?.method ?? "GET") === "GET") return json(state);
    const body = JSON.parse(String(init?.body)) as { replyGuidelines: string };
    if (putStatus >= 400) return json({ code: "invalid_body", error: "Guidelines must be text of at most 1000 characters." }, putStatus);
    return json({ reviewsAiConfig: { replyGuidelines: body.replyGuidelines.trim(), updatedAt: "2026-09-14T09:00:00.000Z" } });
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

async function render() {
  await act(async () => root.render(createElement(ReputationSettings)));
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}
const byId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const area = () => byId("rep-settings-guidelines") as HTMLTextAreaElement;
async function type(value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area(), value);
  await act(async () => void area().dispatchEvent(new Event("input", { bubbles: true })));
}
const puts = () => fetchMock.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === "PUT").map(([, i]) => JSON.parse(String(i.body)));

describe("the page", () => {
  it("shows loading while the sub-account loads", async () => {
    ctx.loading = true;
    ctx.subAccount = null;
    await render();
    expect(byId("rep-settings-loading")).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mounts the existing review-request section and links to where Google is connected", async () => {
    await render();
    expect(byId("review-request-section")).not.toBeNull();
    expect(byId("rep-settings-google-link")?.getAttribute("href")).toBe("/sa/sa1/ai-agents/google-business");
  });
});

describe("the Reviews AI card", () => {
  it("an admin sees and saves the guidelines, with the no-auto-post line", async () => {
    await render();
    expect(area().value).toBe("Sign off as The Fixture Team.");
    expect(byId("rep-settings-ai-card")?.textContent).toContain("Nothing is posted to Google until you click Post reply to Google");
    await type("  Warm and brief. Sign off as The Fixture Team.  ");
    await act(async () => byId("rep-settings-guidelines-save")!.click());
    expect(puts()).toEqual([{ replyGuidelines: "  Warm and brief. Sign off as The Fixture Team.  " }]);
    expect(byId("rep-settings-guidelines-saved")).not.toBeNull();
    expect(area().value).toBe("Warm and brief. Sign off as The Fixture Team.");
  });

  it("counts characters to 1000 and will not send more", async () => {
    await render();
    expect(area().maxLength).toBe(1000);
    await type("x".repeat(40));
    expect(byId("rep-settings-guidelines-count")?.textContent).toBe("40 / 1000");
  });

  it("shows the server's refusal inline", async () => {
    putStatus = 400;
    await render();
    await act(async () => byId("rep-settings-guidelines-save")!.click());
    expect(byId("rep-settings-guidelines-error")?.textContent).toBe("Guidelines must be text of at most 1000 characters.");
  });

  it("a member reads them but cannot save", async () => {
    ctx.isAdmin = false;
    await render();
    expect(area().readOnly).toBe(true);
    expect(byId("rep-settings-guidelines-save")).toBeNull();
    expect(byId("rep-settings-guidelines-readonly")).not.toBeNull();
  });

  it("gate off: says so, and offers no editing", async () => {
    state = { ...state, enabled: false };
    await render();
    expect(byId("rep-settings-ai-gate-off")).not.toBeNull();
    expect(byId("rep-settings-guidelines")).toBeNull();
  });

  it("not configured: says drafts are unavailable here, but guidelines can still be saved", async () => {
    state = { ...state, configured: false };
    await render();
    expect(byId("rep-settings-ai-not-configured")?.textContent).toContain("isn't configured on this deployment");
    expect(byId("rep-settings-guidelines-save")).not.toBeNull();
  });

  it("a failed load says so", async () => {
    fetchMock.mockImplementation(async () => json({ error: "x" }, 500));
    await render();
    expect(byId("rep-settings-ai-error")).not.toBeNull();
  });
});
