// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Send Review Request dialog's listing select (MULTI_LISTING_V1_PLAN.md
 * PR 5), rendered for real (jsdom): hidden with one listing, defaulting to
 * the main (today's body, no locationName), and picking an extra sends its
 * locationName. Contacts and the picker's modal are stubbed as in
 * send-review-request.test.ts.
 */

const ctx = vi.hoisted(() => ({ subAccountId: "sa1", agencyId: "ag1", subAccount: {} as Record<string, unknown> }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "u1" }, loading: false }) }));
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

import { ContactsProvider } from "@/context/contacts-context";
import { SendReviewRequestButton } from "./send-review-request";

// The dialog reads contacts from the sub-account layout's shared provider.
const renderButton = () => createElement(ContactsProvider, null, createElement(SendReviewRequestButton, { onSent }));

const fetchMock = vi.fn();
const onSent = vi.fn();
let container: HTMLDivElement;
let root: Root;

const MAIN = { locationName: "locations/main-1", title: "Fixture Main" };
const B = { locationName: "locations/extra-b", title: "Fixture North" };

beforeEach(() => {
  ctx.subAccount = { googleListing: MAIN, googleExtraListings: [B] };
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
  await act(async () => root.render(renderButton()));
  await click("rep-send-open");
  expect(byId("rep-send-contacts-loading")).not.toBeNull();
  expect(contacts.scope).toEqual({ agencyId: "ag1", subAccountId: "sa1" });
  await act(async () => contacts.emit?.([{ id: "c1", name: "Fixture Person" }]));
  expect((byId("rep-send-submit") as HTMLButtonElement).disabled).toBe(true);
  await click("pick-first");
}

const select = () => byId("rep-send-listing") as HTMLSelectElement | null;
const sentBody = () => JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as Record<string, unknown>;
async function choose(value: string) {
  await act(async () => {
    const el = select()!;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("which listing's review link", () => {
  it.each([
    ["only a main listing", { googleListing: MAIN }],
    ["no listing at all", {}],
  ])("with %s: no select, and the body is today's", async (_l, sub) => {
    ctx.subAccount = sub;
    await openAndPick();
    expect(select()).toBeNull();
    answer(200, { ok: true, sent: true });
    await click("rep-send-submit");
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].body).toBe(JSON.stringify({ contactId: "c1" }));
  });

  it("with an extra: the select lists both, defaults to the main, and the default sends no locationName", async () => {
    await openAndPick();
    expect([...select()!.options].map((o) => [o.value, o.text])).toEqual([["", "Fixture Main"], [B.locationName, "Fixture North"]]);
    expect(select()!.value).toBe("");
    answer(200, { ok: true, sent: true });
    await click("rep-send-submit");
    expect(sentBody()).toEqual({ contactId: "c1" });
  });

  it("picking the extra sends its locationName", async () => {
    await openAndPick();
    await choose(B.locationName);
    answer(200, { ok: true, sent: true });
    await click("rep-send-submit");
    expect(sentBody()).toEqual({ contactId: "c1", locationName: B.locationName });
    expect(byId("rep-send-result")?.textContent).toBe("Review request sent.");
  });

  it("an extra with no adopted link is refused in plain words", async () => {
    await openAndPick();
    await choose(B.locationName);
    answer(200, { ok: true, sent: false, reason: "listing_url_not_configured" });
    await click("rep-send-submit");
    expect(byId("rep-send-result")?.textContent).toContain("This listing has no review link yet.");
  });

  it("reopening the dialog goes back to the main listing", async () => {
    await openAndPick();
    await choose(B.locationName);
    await act(async () => root.render(renderButton()));
    await click("rep-send-open");
    expect(select()!.value).toBe("");
  });
});
