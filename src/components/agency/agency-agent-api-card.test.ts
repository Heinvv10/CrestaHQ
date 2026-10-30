// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * With the agency Agent API switch OFF the key list and Revoke stay usable
 * (PR #346 review): an owner reacting to a leak switches it off first and must
 * not have to re-arm every key to revoke one. Only Mint is gated on the switch.
 */

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const agency = vi.hoisted(() => ({ value: { loading: false, agentApiEnabled: false } }));
vi.mock("@/hooks/use-agency", () => ({ useAgency: () => agency.value }));

import { AgencyAgentApiCard } from "./agency-agent-api-card";

const KEY = { id: "k1", name: "Leaked agent", prefix: "abc", createdAt: "2026-10-01T00:00:00Z", lastUsedAt: null };
const fetchMock = vi.fn();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async (_url: string, init?: RequestInit) =>
    ({ ok: true, status: 200, json: async () => (init?.method === "DELETE" ? { ok: true } : { keys: [KEY], reach: [] }) }),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", () => true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(agentApiEnabled: boolean) {
  agency.value = { loading: false, agentApiEnabled };
  await act(async () => root.render(createElement(AgencyAgentApiCard)));
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}
const button = (label: RegExp) =>
  [...container.querySelectorAll("button")].find((b) => label.test(b.getAttribute("aria-label") ?? b.textContent ?? ""));

describe("agency keys card with the Agent API switch off", () => {
  it("lists the keys and revokes one, but offers no mint", async () => {
    await render(false);
    expect(container.textContent).toContain("Leaked agent");
    expect(button(/New agency key/)).toBeUndefined();
    await act(async () => button(/Revoke Leaked agent/)!.click());
    expect(fetchMock).toHaveBeenCalledWith("/api/agency/api-keys/k1", { method: "DELETE" });
  });

  it("offers mint once the switch is on", async () => {
    await render(true);
    expect(button(/New agency key/)).toBeDefined();
  });
});
