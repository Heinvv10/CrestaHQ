// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleBusinessPanel } from "./google-business-panel";

/**
 * Every state of the Google Business page, rendered for real (jsdom) from the
 * sub-account doc the page reads, with only `fetch` and the context stubbed.
 */

const ctx = vi.hoisted(() => ({
  subAccountId: "sa1",
  isAdmin: true,
  loading: false,
  subAccount: {} as Record<string, unknown>,
}));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx }));

const LISTING = {
  accountName: "accounts/a1",
  accountDisplayName: "Fixture Group",
  locationName: "locations/l1",
  title: "Fixture Fibre — North",
  address: "9 Fixture Avenue",
  websiteUri: null,
  placeId: "fake-place",
  mapsUri: null,
  newReviewUri: null,
};
const CONNECTED = { connected: true, email: null, scopes: [] };

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
let routes: Record<string, () => unknown>;

beforeEach(() => {
  ctx.isAdmin = true;
  ctx.loading = false;
  ctx.subAccount = { googleEnabledByAgency: true };
  routes = {
    "GET /api/sub-accounts/sa1/google/status": () => json({ configured: true }),
    "GET /api/sub-accounts/sa1/google/locations": () => json({ accounts: [], truncated: false }),
    "DELETE /api/sub-accounts/sa1/google": () => json({ ok: true }),
    "DELETE /api/sub-accounts/sa1/google/listing": () => json({ ok: true }),
  };
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    const handler = routes[`${init?.method ?? "GET"} ${url}`];
    if (!handler) throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
    return handler();
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("alert", vi.fn());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  // Automation-freezing dialogs are never used, in any state.
  expect(window.confirm).not.toHaveBeenCalled();
  expect(window.alert).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(createElement(GoogleBusinessPanel)));
}
const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
  if (!button) throw new Error(`no button "${label}" in: ${container.textContent}`);
  await act(async () => button.click());
}
const calls = (method: string, url: string) =>
  fetchMock.mock.calls.filter(([u, i]) => u === url && ((i as RequestInit | undefined)?.method ?? "GET") === method);

describe("gate locked", () => {
  it("shows the locked state and calls nothing", async () => {
    ctx.subAccount = { googleEnabledByAgency: false };
    await render();
    expect(byId("gbp-state-gate-locked")).not.toBeNull();
    expect(container.textContent).not.toContain("Disconnect");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still lets an admin disconnect an existing connection, via an inline confirm", async () => {
    ctx.subAccount = { googleEnabledByAgency: false, googleConnectionMeta: CONNECTED };
    await render();
    await click("Disconnect Google");
    expect(calls("DELETE", "/api/sub-accounts/sa1/google")).toHaveLength(0);
    await click("Yes, disconnect");
    expect(calls("DELETE", "/api/sub-accounts/sa1/google")).toHaveLength(1);
  });

  it("offers a non-admin no disconnect", async () => {
    ctx.isAdmin = false;
    ctx.subAccount = { googleEnabledByAgency: false, googleConnectionMeta: CONNECTED };
    await render();
    expect(container.textContent).not.toContain("Disconnect");
  });
});

describe("states", () => {
  it("shows a read-only notice to non-admins", async () => {
    ctx.isAdmin = false;
    ctx.subAccount = { googleEnabledByAgency: true, googleConnectionMeta: CONNECTED, googleListing: LISTING };
    await render();
    expect(byId("gbp-state-not-admin")?.textContent).toContain("Fixture Fibre — North");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("shows not-configured when the deployment has no usable Google provider", async () => {
    routes["GET /api/sub-accounts/sa1/google/status"] = () => json({ configured: false });
    await render();
    expect(byId("gbp-state-not-configured")?.textContent).toContain("Not configured on this deployment");
    expect(byId("gbp-connect")).toBeNull();
  });

  it("shows reconnect guidance, with the reason, when the grant was refused", async () => {
    ctx.subAccount = {
      googleEnabledByAgency: true,
      googleConnectionMeta: { ...CONNECTED, reconnectRequired: true, reconnectReason: "insufficient_scope" },
      googleListing: LISTING,
    };
    await render();
    expect(byId("gbp-state-reconnect")?.textContent).toContain("permission was not granted");
    expect(byId("gbp-reconnect")).not.toBeNull();
  });

  it.each([
    ["auth_expired", "Google rejected this connection's credentials"],
    ["permission_denied", "doesn't have permission"],
    ["transient", "temporarily unavailable"],
    ["malformed", "unexpected response"],
  ])("explains a picker load failure (%s)", async (code, text) => {
    ctx.subAccount = { googleEnabledByAgency: true, googleConnectionMeta: CONNECTED };
    routes["GET /api/sub-accounts/sa1/google/locations"] = () => json({ error: "x", code }, 502);
    await render();
    expect(byId("gbp-picker-error")?.textContent).toContain(text);
  });
});

describe("selected listing", () => {
  beforeEach(() => {
    ctx.subAccount = { googleEnabledByAgency: true, googleConnectionMeta: CONNECTED, googleListing: LISTING };
  });

  it("re-opens the picker on Change listing, and Cancel returns", async () => {
    await render();
    expect(byId("gbp-state-selected")).not.toBeNull();
    await click("Change listing");
    expect(byId("gbp-state-pick")).not.toBeNull();
    await click("Cancel");
    expect(byId("gbp-state-selected")).not.toBeNull();
  });

  it("stops managing the listing only after an inline confirm", async () => {
    await render();
    await click("Stop managing this listing");
    expect(calls("DELETE", "/api/sub-accounts/sa1/google/listing")).toHaveLength(0);
    await click("Cancel");
    await click("Stop managing this listing");
    await click("Yes, stop managing");
    expect(calls("DELETE", "/api/sub-accounts/sa1/google/listing")).toHaveLength(1);
  });
});
