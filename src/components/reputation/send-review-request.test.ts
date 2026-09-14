// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Send Review Request (SP5 d1), rendered for real (jsdom): pick a contact,
 * POST the existing manual route, show its answer inline in plain words.
 * The contact list and the picker's own modal are stubbed (the real picker
 * runs in e2e/specs/reputation-requests.spec.ts).
 */

vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ({ subAccountId: "sa1", agencyId: "ag1" }) }));
vi.mock("@/hooks/use-effective-territory-filter", () => ({ useEffectiveTerritoryFilter: () => ({ ready: true, filter: null }) }));
const contacts = vi.hoisted(() => ({
  emit: null as null | ((c: unknown[]) => void),
  fail: null as null | ((e: Error) => void),
  scope: null as unknown,
}));
vi.mock("@/lib/firestore/contacts", () => ({
  subscribeToContacts: (scope: unknown, _opts: unknown, cb: (c: unknown[]) => void, onError: (e: Error) => void) => {
    contacts.scope = scope;
    contacts.emit = cb;
    contacts.fail = onError;
    return () => {};
  },
}));
vi.mock("@/components/quotes/contact-picker", async () => {
  const { createElement: h } = await import("react");
  return {
    ContactPicker: ({ contacts: list, onChange }: { contacts: Array<{ id: string }>; onChange: (id: string) => void }) =>
      h("div", null,
        h("button", { type: "button", "data-testid": "pick-first", onClick: () => onChange(list[0].id) }, `pick of ${list.length}`),
        h("button", { type: "button", "data-testid": "pick-last", onClick: () => onChange(list[list.length - 1].id) }, "last")),
  };
});

import { SendReviewRequestButton } from "./send-review-request";

const fetchMock = vi.fn();
const onSent = vi.fn();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fetchMock.mockReset();
  onSent.mockReset();
  contacts.emit = null;
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

const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const click = (id: string) => act(async () => (byId(id) as HTMLButtonElement).click());
const answer = (status: number, body: unknown) => fetchMock.mockResolvedValueOnce({ ok: status < 400, status, json: async () => body });

async function openAndPick() {
  await act(async () => root.render(createElement(SendReviewRequestButton, { onSent })));
  await click("rep-send-open");
  expect(byId("rep-send-contacts-loading")).not.toBeNull();
  expect(contacts.scope).toEqual({ agencyId: "ag1", subAccountId: "sa1" });
  await act(async () => contacts.emit?.([{ id: "c1", name: "Fixture Person" }]));
  expect((byId("rep-send-submit") as HTMLButtonElement).disabled).toBe(true);
  await click("pick-first");
}

describe("send review request dialog", () => {
  it("sends to the picked contact through the manual route and says so", async () => {
    await openAndPick();
    answer(200, { ok: true, sent: true });
    await click("rep-send-submit");
    expect(fetchMock).toHaveBeenCalledWith("/api/comms/review-request/send", expect.objectContaining({
      method: "POST", body: JSON.stringify({ contactId: "c1" }),
    }));
    expect(byId("rep-send-result")?.getAttribute("data-state")).toBe("sent");
    expect(byId("rep-send-result")?.textContent).toBe("Review request sent.");
    expect(onSent).toHaveBeenCalledTimes(1);
    // Not a second time to the same contact by a double click: Send stays off until the contact changes.
    expect((byId("rep-send-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("after a send, choosing another contact turns Send back on", async () => {
    await act(async () => root.render(createElement(SendReviewRequestButton, { onSent })));
    await click("rep-send-open");
    await act(async () => contacts.emit?.([{ id: "c1", name: "One" }, { id: "c2", name: "Two" }]));
    await click("pick-first");
    answer(200, { ok: true, sent: true });
    await click("rep-send-submit");
    expect((byId("rep-send-submit") as HTMLButtonElement).disabled).toBe(true);
    await click("pick-last");
    expect((byId("rep-send-submit") as HTMLButtonElement).disabled).toBe(false);
    // Re-picking the contact that was just sent to does not re-arm it.
    await click("pick-first");
    expect((byId("rep-send-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("contacts that fail to load say so, instead of an empty list", async () => {
    await act(async () => root.render(createElement(SendReviewRequestButton, { onSent })));
    await click("rep-send-open");
    await act(async () => contacts.fail?.(new Error("permission-denied")));
    expect(byId("rep-send-contacts-error")?.textContent).toContain("Contacts could not be loaded");
    expect(byId("pick-first")).toBeNull();
    expect((byId("rep-send-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ["not_configured", "Set your review link first (Settings Sub-Account → Messaging tab)."],
    ["opted_out", "This contact has opted out of the channel review requests use."],
    ["no_phone", "This contact has no phone number."],
    ["cooldown", "This contact was asked for a review recently."],
    ["window_closed", "This contact hasn't messaged you on WhatsApp in the last 24 hours"],
    ["something_new", "The review request couldn't be sent. Please try again."],
  ])("a refusal (%s) is said in plain words", async (reason, words) => {
    await openAndPick();
    answer(200, { ok: true, sent: false, reason });
    await click("rep-send-submit");
    expect(byId("rep-send-result")?.getAttribute("data-state")).toBe("refused");
    expect(byId("rep-send-result")?.textContent).toContain(words);
    expect(onSent).not.toHaveBeenCalled();
  });

  it("a route error shows the route's message", async () => {
    await openAndPick();
    answer(403, { error: "Contact not in your sub-account" });
    await click("rep-send-submit");
    expect(byId("rep-send-result")?.getAttribute("data-state")).toBe("error");
    expect(byId("rep-send-result")?.textContent).toBe("Contact not in your sub-account");
  });

  it("a network failure is an inline error, never an alert", async () => {
    const alert = vi.fn();
    vi.stubGlobal("alert", alert);
    await openAndPick();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await click("rep-send-submit");
    expect(byId("rep-send-result")?.getAttribute("data-state")).toBe("error");
    expect(alert).not.toHaveBeenCalled();
  });
});
