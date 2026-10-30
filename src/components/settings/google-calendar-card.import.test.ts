// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/** The import controls hang off the Google Calendar card: hidden with the gate, kept through a failed re-read. */
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({
    isAdmin: true,
    subAccountId: "sa1",
    subAccount: { googleCalendarEnabledByAgency: true },
  }),
}));

const { GoogleCalendarCard } = await import("./google-calendar-card");
const { POLL_MS } = await import("./google-calendar-import-controls");

const fetchMock = vi.fn();
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const reply = (body: unknown, ok = true) => ({ ok, json: async () => body });
const show = () =>
  act(async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(createElement(GoogleCalendarCard));
  });
const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const connected = {
  configured: true,
  connected: true,
  status: "connected",
  googleEmail: "a@example.com",
  importAllowed: true,
  importMode: "busy",
  importedCount: 0,
};

it("shows no import controls while the agency gate is off", async () => {
  fetchMock.mockResolvedValue(reply({ gateOff: true, connected: true, googleEmail: "a@example.com" }));
  await show();
  expect(byId("gcal-gate-off")).not.toBeNull();
  expect(byId("gcal-import")).toBeNull();
});

it("shows the import controls once connected and the gate is on", async () => {
  fetchMock.mockResolvedValue(reply(connected));
  await show();
  expect(byId("gcal-import")).not.toBeNull();
});

it("a failed re-read shows the error, keeps the controls, and the next poll recovers", async () => {
  vi.useFakeTimers();
  fetchMock.mockResolvedValueOnce(reply(connected)).mockResolvedValueOnce(reply({ error: "Boom" }, false));
  await show();
  expect(byId("gcal-import")).not.toBeNull();
  await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS)));
  expect(document.body.textContent).toContain("Boom");
  expect(byId("gcal-import")).not.toBeNull();
  // Polling was not killed by the failure.
  fetchMock.mockResolvedValue(reply({ ...connected, importLastSyncAt: new Date().toISOString(), importedCount: 2 }));
  await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS)));
  expect(document.body.textContent).not.toContain("Boom");
  expect(byId("gcal-import-status")?.textContent).toMatch(/^2 events, synced/);
});
