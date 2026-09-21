// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SubAccountGoogleSection } from "./sub-account-google-section";

/** The Settings card must not show a green "connected" for a refused grant. */

const ctx = vi.hoisted(() => ({
  subAccountId: "sa1",
  isAdmin: true,
  subAccount: {} as Record<string, unknown>,
}));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx }));

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

async function render(meta: Record<string, unknown>) {
  ctx.subAccount = { googleEnabledByAgency: true, googleConnectionMeta: meta };
  await act(async () => root.render(createElement(SubAccountGoogleSection)));
}
const buttons = () => Array.from(container.querySelectorAll("button")).map((b) => b.textContent?.trim());

it("shows a healthy connection as connected", async () => {
  await render({ connected: true, email: null, scopes: [] });
  expect(container.textContent).toContain("Business Profile management access granted");
});

it("shows reconnect guidance, not 'connected', when the grant was refused", async () => {
  await render({ connected: true, email: null, scopes: [], reconnectRequired: true, reconnectReason: "revoked" });
  expect(container.querySelector('[data-testid="google-settings-reconnect"]')).not.toBeNull();
  expect(container.textContent).toContain("Google no longer accepts this connection");
  expect(container.textContent).not.toContain("access granted");
  expect(buttons()).toEqual(expect.arrayContaining(["Reconnect", "Disconnect"]));
});
