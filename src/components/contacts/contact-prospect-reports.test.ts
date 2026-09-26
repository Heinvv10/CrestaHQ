// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The contact profile's Prospect reports card: hidden unless the agency gate
 * is on, Generate disabled once the month's quota is used, and the list polls
 * only while a report is still queued or running.
 */

let subAccount: Record<string, unknown>;

vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({ subAccount, subAccountId: "sa1", saPath: (p: string) => `/sa/sa1${p}` }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), message: vi.fn() } }));

import { ContactProspectReports, POLL_MS } from "./contact-prospect-reports";

type Row = { id: string; status: string; headline: string | null; shared: boolean; createdAt: string | null };

let list: { reports: Row[]; quota: number; used: number };
let fetchMock: ReturnType<typeof vi.fn>;
let root: Root;
let container: HTMLDivElement;

const listCalls = () =>
  fetchMock.mock.calls.filter(([url, init]) => String(url).includes("?contactId=") && !init?.method).length;
const generateButton = () =>
  container.querySelector<HTMLButtonElement>('[data-testid="prospect-report-generate"]');

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(ContactProspectReports, { contactId: "c1" })));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  subAccount = { prospectingEnabledByAgency: true };
  list = { reports: [], quota: 5, used: 0 };
  fetchMock = vi.fn(async () => new Response(JSON.stringify(list), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ContactProspectReports", () => {
  it("renders nothing and fetches nothing while the gate is off", async () => {
    subAccount = { prospectingEnabledByAgency: false };
    await mount();
    expect(container.innerHTML).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a missing gate field as off", async () => {
    subAccount = {};
    await mount();
    expect(container.innerHTML).toBe("");
  });

  it("enables Generate under quota and disables it at quota with the reason", async () => {
    list = { reports: [], quota: 5, used: 4 };
    await mount();
    expect(generateButton()!.disabled).toBe(false);
    expect(container.textContent).toContain("4 of 5 reports used this month");

    await act(async () => root.unmount());
    list = { reports: [], quota: 5, used: 5 };
    await mount();
    expect(generateButton()!.disabled).toBe(true);
    expect(container.textContent).toContain("5 of 5 reports used this month");
    expect(container.textContent).toContain("quota is used up");
  });

  it("polls while a report is running and stops once it is ready", async () => {
    list = { reports: [{ id: "r1", status: "running", headline: null, shared: false, createdAt: null }], quota: 5, used: 1 };
    await mount();
    expect(listCalls()).toBe(1);

    await act(async () => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(listCalls()).toBe(2);

    list = { ...list, reports: [{ id: "r1", status: "ready", headline: "No opening hours", shared: false, createdAt: null }] };
    await act(async () => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(listCalls()).toBe(3);
    expect(container.textContent).toContain("No opening hours");

    await act(async () => vi.advanceTimersByTimeAsync(POLL_MS * 5));
    expect(listCalls()).toBe(3);
  });

  it("does not poll when nothing is pending, and stops on unmount", async () => {
    list = { reports: [{ id: "r1", status: "queued", headline: null, shared: false, createdAt: null }], quota: 5, used: 1 };
    await mount();
    await act(async () => root.unmount());
    await act(async () => vi.advanceTimersByTimeAsync(POLL_MS * 3));
    expect(listCalls()).toBe(1);

    list = { reports: [{ id: "r1", status: "failed", headline: null, shared: false, createdAt: null }], quota: 5, used: 1 };
    await mount();
    await act(async () => vi.advanceTimersByTimeAsync(POLL_MS * 3));
    expect(listCalls()).toBe(2);
  });

  it("shows the quota message on a 429 from Generate", async () => {
    await mount();
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ error: "x", code: "quota_exhausted" }), { status: 429 }),
    );
    await act(async () => generateButton()!.click());
    expect(container.textContent).toContain("This month's report quota is used up.");
  });
});
