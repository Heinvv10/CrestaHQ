// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CalendarEvent } from "@/types/events";

/**
 * Retry sync tells the page the error is cleared only when the route's 200
 * says the event is now synced — never on a refusal or a failed push.
 */
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { GoogleSyncNotice } = await import("./google-sync-notice");

const event = {
  id: "e1",
  googleSyncError: { message: "Not in Ann's Google Calendar" },
} as unknown as CalendarEvent;

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

async function retry(status: number, body: unknown) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
  const onSynced = vi.fn();
  await act(async () => root.render(createElement(GoogleSyncNotice, { event, onSynced })));
  const button = container.querySelector<HTMLButtonElement>('[data-testid="google-sync-retry"]')!;
  await act(async () => button.click());
  expect(fetchMock).toHaveBeenCalledWith("/api/events/by-id/e1/google-sync", { method: "POST" });
  return onSynced;
}

it("reports the error cleared when the 200 says synced", async () => {
  expect((await retry(200, { ok: true, synced: true, googleSyncError: null })).mock.calls).toEqual([[]]);
});

it("reports nothing when the retry ran but the push failed again", async () => {
  expect(await retry(200, { ok: true, synced: false, googleSyncError: "Still failing" })).not.toHaveBeenCalled();
});

it("reports nothing when the 200 does not say whether it synced", async () => {
  expect(await retry(200, { ok: true, googleSyncError: null })).not.toHaveBeenCalled();
});

it("reports nothing on a refusal", async () => {
  // The body claims synced on purpose: only the !res.ok guard keeps this from reporting.
  expect(await retry(429, { error: "Retried moments ago — wait 30 seconds.", synced: true })).not.toHaveBeenCalled();
});
