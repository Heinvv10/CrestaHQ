// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Contact } from "@/types/contacts";

/**
 * One contacts listener per sub-account session: started by the first page
 * that needs it, kept across page switches, re-issued only when the query
 * itself (user, sub-account, territory filter) changes.
 */
const state = vi.hoisted(() => ({
  auth: { user: { uid: "u1" } as { uid: string } | null, loading: false },
  sub: { subAccountId: "sa1", agencyId: "ag1" as string | null },
  territory: { ready: true, filter: null as string[] | null },
  subs: [] as Array<{
    scope: unknown;
    opts: { territoryFilter?: string[] | null; waitForServer?: boolean };
    deliver: (l: unknown[]) => void;
    fail: (e: Error) => void;
    unsub: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => state.auth }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => state.sub }));
vi.mock("@/hooks/use-effective-territory-filter", () => ({
  useEffectiveTerritoryFilter: () => state.territory,
}));
vi.mock("@/lib/firestore/contacts", () => ({
  subscribeToContacts: (
    scope: unknown,
    opts: (typeof state.subs)[number]["opts"],
    deliver: (l: unknown[]) => void,
    fail: (e: Error) => void,
  ) => {
    const unsub = vi.fn();
    state.subs.push({ scope, opts, deliver, fail, unsub });
    return unsub;
  },
}));

import { SLOW_AFTER_MS } from "@/hooks/use-loading-hint";
import {
  ContactsProvider,
  useSubAccountContacts,
  type SubAccountContacts,
} from "./contacts-context";

const LIST = [{ id: "c1" }, { id: "c2" }] as Contact[];
const seen: Record<string, SubAccountContacts> = {};

function Consumer({
  name,
  enabled,
  ownsLoadingHint,
}: {
  name: string;
  enabled?: boolean;
  ownsLoadingHint?: boolean;
}) {
  seen[name] = useSubAccountContacts(enabled, { ownsLoadingHint });
  return null;
}
const Bare = () => null;

let root: ReturnType<typeof createRoot>;
let el: HTMLDivElement;
async function render(...children: ReactNode[]) {
  await act(async () =>
    root.render(createElement(ContactsProvider, null, ...children)),
  );
}
const consumer = (name: string, enabled?: boolean) =>
  createElement(Consumer, { key: name, name, enabled });
const latest = () => state.subs[state.subs.length - 1];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.auth = { user: { uid: "u1" }, loading: false };
  state.sub = { subAccountId: "sa1", agencyId: "ag1" };
  state.territory = { ready: true, filter: null };
  state.subs = [];
  for (const k of Object.keys(seen)) delete seen[k];
  el = document.createElement("div");
  root = createRoot(el);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("downloads nothing until a consumer asks", async () => {
  await render(createElement(Bare, { key: "bare" }));
  expect(state.subs).toHaveLength(0);
  await render(consumer("a"));
  expect(state.subs).toHaveLength(1);
});

it("a closed dialog (enabled: false) does not start the download", async () => {
  await render(consumer("dialog", false));
  expect(state.subs).toHaveLength(0);
  expect(seen.dialog.loading).toBe(true);
  await render(consumer("dialog", true));
  expect(state.subs).toHaveLength(1);
});

it("loads from the server only, then hands every consumer the same list", async () => {
  await render(consumer("a"), consumer("b"));
  expect(state.subs).toHaveLength(1);
  expect(latest().scope).toEqual({ agencyId: "ag1", subAccountId: "sa1" });
  // A cache-seeded partial list must never be shown as the whole list.
  expect(latest().opts.waitForServer).toBe(true);
  expect(seen.a.loading).toBe(true);
  expect(seen.a.contacts).toEqual([]);
  await act(async () => latest().deliver(LIST));
  expect(seen.a).toMatchObject({ loading: false, contacts: LIST, error: null });
  expect(seen.b.contacts).toBe(seen.a.contacts);
});

it("keeps the listener when the page that asked for it unmounts", async () => {
  await render(consumer("page1"));
  await act(async () => latest().deliver(LIST));
  const first = latest();
  // Navigate to a page that doesn't use contacts, then to one that does.
  await render(createElement(Bare, { key: "bare" }));
  expect(first.unsub).not.toHaveBeenCalled();
  await render(consumer("page2"));
  expect(state.subs).toHaveLength(1);
  expect(seen.page2).toMatchObject({ loading: false, contacts: LIST });
});

it("passes the territory filter through and re-subscribes when it changes", async () => {
  state.territory = { ready: true, filter: ["global", "t1"] };
  await render(consumer("a"));
  expect(latest().opts.territoryFilter).toEqual(["global", "t1"]);
  await act(async () => latest().deliver(LIST));
  const first = latest();

  state.territory = { ready: true, filter: ["global", "t2"] };
  await render(consumer("a"));
  expect(first.unsub).toHaveBeenCalledTimes(1);
  expect(state.subs).toHaveLength(2);
  expect(latest().opts.territoryFilter).toEqual(["global", "t2"]);
  // The old territory's list is not shown as the new one's.
  expect(seen.a).toMatchObject({ loading: true, contacts: [] });
});

it("waits for the territory filter before subscribing", async () => {
  state.territory = { ready: false, filter: null };
  await render(consumer("a"));
  expect(state.subs).toHaveLength(0);
  expect(seen.a.loading).toBe(true);
  state.territory = { ready: true, filter: [] };
  await render(consumer("a"));
  expect(state.subs).toHaveLength(1);
  expect(latest().opts.territoryFilter).toEqual([]);
});

it("waits for auth, and re-subscribes for a different user", async () => {
  state.auth = { user: null, loading: true };
  await render(consumer("a"));
  expect(state.subs).toHaveLength(0);
  // A cached user while auth is still resolving is not enough either.
  state.auth = { user: { uid: "u1" }, loading: true };
  await render(consumer("a"));
  expect(state.subs).toHaveLength(0);
  state.auth = { user: { uid: "u1" }, loading: false };
  await render(consumer("a"));
  expect(state.subs).toHaveLength(1);
  state.auth = { user: { uid: "u2" }, loading: false };
  await render(consumer("a"));
  expect(state.subs[0].unsub).toHaveBeenCalledTimes(1);
  expect(state.subs).toHaveLength(2);
});

it("a sub-account switch goes back to loading and subscribes to the new one", async () => {
  await render(consumer("a"));
  await act(async () => latest().deliver(LIST));
  state.sub = { subAccountId: "sa2", agencyId: "ag1" };
  await render(consumer("a"));
  expect(state.subs[0].unsub).toHaveBeenCalledTimes(1);
  expect(latest().scope).toEqual({ agencyId: "ag1", subAccountId: "sa2" });
  expect(seen.a).toMatchObject({ loading: true, contacts: [] });
});

it("a sub-account switch with no consumer mounted downloads nothing", async () => {
  await render(consumer("a"));
  await render(createElement(Bare, { key: "bare" }));
  state.sub = { subAccountId: "sa2", agencyId: "ag1" };
  await render(createElement(Bare, { key: "bare" }));
  expect(state.subs[0].unsub).toHaveBeenCalledTimes(1);
  expect(state.subs).toHaveLength(1);
});

it("unsubscribes when the provider unmounts", async () => {
  await render(consumer("a"));
  await act(async () => root.unmount());
  expect(state.subs[0].unsub).toHaveBeenCalledTimes(1);
  root = createRoot(document.createElement("div"));
});

it("a failed listener stops loading, reports the error, and the next page retries", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await render(consumer("page1"));
  await act(async () => latest().fail(new Error("permission-denied")));
  expect(seen.page1.loading).toBe(false);
  expect(seen.page1.error?.message).toBe("permission-denied");
  await render(createElement(Bare, { key: "bare" }));
  await render(consumer("page2"));
  expect(state.subs).toHaveLength(2);
  await act(async () => latest().deliver(LIST));
  expect(seen.page2).toMatchObject({ loading: false, contacts: LIST, error: null });
});

it("refuses to run outside the provider", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await expect(
    act(async () => root.render(createElement(Consumer, { name: "x" }))),
  ).rejects.toThrow(/ContactsProvider/);
});

it("signing out forgets the request and the list", async () => {
  await render(consumer("a"));
  await act(async () => latest().deliver(LIST));
  state.auth = { user: null, loading: false };
  await render(createElement(Bare, { key: "bare" }));
  // The same user comes back: no consumer mounted, so nothing downloads.
  state.auth = { user: { uid: "u1" }, loading: false };
  await render(createElement(Bare, { key: "bare" }));
  expect(state.subs).toHaveLength(1);
  // A page that asks now waits for the server, not the old list.
  await render(consumer("b"));
  expect(state.subs).toHaveLength(2);
  expect(seen.b).toMatchObject({ loading: true, contacts: [] });
});

describe("the wait hint", () => {
  const offlineText = "You're offline. Contacts will load when your connection is back.";
  const slowText = "taking longer than usual";
  function setOnline(v: boolean) {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(v);
  }

  it("says so when offline, and clears once the server answers", async () => {
    setOnline(false);
    await render(consumer("a"));
    expect(el.querySelector('[role="status"]')?.textContent).toBe(offlineText);
    await act(async () => latest().deliver(LIST));
    expect(el.querySelector('[role="status"]')).toBeNull();
  });

  it("is not shown while nobody is waiting", async () => {
    setOnline(false);
    await render(createElement(Bare, { key: "bare" }), consumer("dialog", false));
    expect(el.querySelector('[role="status"]')).toBeNull();
  });

  it("leaves it to a page that shows its own hint", async () => {
    setOnline(false);
    await render(
      createElement(Consumer, { key: "page", name: "page", ownsLoadingHint: true }),
    );
    expect(state.subs).toHaveLength(1);
    expect(el.querySelector('[role="status"]')).toBeNull();
  });

  it("says a load is slow, and a new load restarts the timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await render(consumer("a"));
      expect(el.textContent).not.toContain(slowText);
      await act(async () => vi.advanceTimersByTime(SLOW_AFTER_MS));
      expect(el.textContent).toContain(slowText);
      state.territory = { ready: true, filter: ["global", "t2"] };
      await render(consumer("a"));
      expect(el.textContent).not.toContain(slowText);
      await act(async () => vi.advanceTimersByTime(SLOW_AFTER_MS));
      expect(el.textContent).toContain(slowText);
    } finally {
      vi.useRealTimers();
    }
  });
});
