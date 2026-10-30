// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * The import controls only reflect and request: the PATCH route enforces the
 * allowance, the gate and the caller-only rule. What matters here is that each
 * control sends exactly the one key the route accepts, and that the admin-only
 * switch is not offered to a member.
 */
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const ctx = vi.hoisted(() => ({ isAdmin: true }));
vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({ isAdmin: ctx.isAdmin, subAccountId: "sa1" }),
}));

const { GoogleImportControls } = await import("./google-calendar-import-controls");
type Status = Parameters<typeof GoogleImportControls>[0]["status"];

const fetchMock = vi.fn();
const onChanged = vi.fn();
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  onChanged.mockReset().mockResolvedValue(undefined);
  toast.success.mockReset();
  toast.error.mockReset();
  ctx.isAdmin = true;
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const connected: Status = { connected: true, importAllowed: true, importMode: "off" };
const show = (status: Status) =>
  act(async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(createElement(GoogleImportControls, { status, onChanged }));
  });
const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (id: string) => act(async () => byId(id)!.click());
const sent = () => fetchMock.mock.calls.map(([url, init]) => [url, JSON.parse((init as RequestInit).body as string)]);

it("sends only { mode } for a mode button and refreshes the status", async () => {
  await show(connected);
  await click("gcal-import-mode-busy");
  expect(sent()).toEqual([["/api/sub-accounts/sa1/google-calendar/import", { mode: "busy" }]]);
  expect(onChanged).toHaveBeenCalled();
});

it("asks before sharing full details, and sends nothing if declined", async () => {
  await show(connected);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await click("gcal-import-mode-details");
  expect(confirm).toHaveBeenCalledOnce();
  expect(fetchMock).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  await click("gcal-import-mode-details");
  expect(sent()).toEqual([["/api/sub-accounts/sa1/google-calendar/import", { mode: "details" }]]);
});

it("offers the workspace switch to an admin only, and asks before turning it off", async () => {
  await show(connected);
  expect(byId("gcal-import-allow")).not.toBeNull();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await click("gcal-import-allow");
  expect(fetchMock).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  await click("gcal-import-allow");
  expect(sent()).toEqual([["/api/sub-accounts/sa1/google-calendar/import", { allowWorkspace: false }]]);

  await act(async () => root.unmount());
  ctx.isAdmin = false;
  await show(connected);
  expect(byId("gcal-import-allow")).toBeNull();
});

it("a member sees no mode buttons while the workspace has not allowed import", async () => {
  ctx.isAdmin = false;
  await show({ connected: true, importAllowed: false, importMode: "off" });
  expect(byId("gcal-import-not-allowed")?.textContent).toContain("Ask an admin");
  expect(byId("gcal-import-mode-busy")).toBeNull();
});

it("asks a member who is allowed but not connected to connect first", async () => {
  await show({ connected: false, importAllowed: true, importMode: "off" });
  expect(byId("gcal-import-connect-first")).not.toBeNull();
  expect(byId("gcal-import-mode-busy")).toBeNull();
});

it("Sync now sends { syncNow: true } and surfaces the server's refusal", async () => {
  await show({ ...connected, importMode: "busy", importLastSyncAt: new Date().toISOString(), importedCount: 3 });
  expect(byId("gcal-import-status")?.textContent).toContain("3 events");
  fetchMock.mockResolvedValue({
    ok: false,
    json: async () => ({ error: "Synced less than a minute ago — try again shortly." }),
  });
  await click("gcal-import-sync");
  expect(sent()).toEqual([["/api/sub-accounts/sa1/google-calendar/import", { syncNow: true }]]);
  expect(toast.error).toHaveBeenCalledWith("Synced less than a minute ago — try again shortly.");
  expect(toast.success).not.toHaveBeenCalled();
});

it("shows a failed sync and the first-sync wait", async () => {
  await show({ ...connected, importMode: "busy", importStatus: "error", importError: "Google said no" });
  expect(byId("gcal-import-status")?.textContent).toContain("Last sync failed: Google said no");
  await act(async () => root.unmount());
  await show({ ...connected, importMode: "busy" });
  expect(byId("gcal-import-status")?.textContent).toContain("First sync in progress");
});
