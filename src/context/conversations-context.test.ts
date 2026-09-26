// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConversationDoc } from "@/types/conversations";

/**
 * One conversations listener per sub-account session: started by the first
 * visit to the inbox, kept across page switches, re-issued only when the
 * query itself (user, sub-account, territory filter) changes.
 */
const state = vi.hoisted(() => ({
  auth: { user: { uid: "u1" } as { uid: string } | null, loading: false },
  sub: { subAccountId: "sa1" },
  territory: { ready: true, filter: null as string[] | null },
  subs: [] as Array<{
    subAccountId: string;
    territoryFilter: string[] | null | undefined;
    opts: { waitForServer?: boolean } | undefined;
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
vi.mock("@/lib/firestore/conversations", () => ({
  subscribeToConversations: (
    subAccountId: string,
    deliver: (l: unknown[]) => void,
    fail: (e: Error) => void,
    territoryFilter: string[] | null | undefined,
    opts: { waitForServer?: boolean } | undefined,
  ) => {
    const unsub = vi.fn();
    state.subs.push({ subAccountId, territoryFilter, opts, deliver, fail, unsub });
    return unsub;
  },
}));

import {
  ConversationsProvider,
  useSubAccountConversations,
  type SubAccountConversations,
} from "./conversations-context";

const LIST = [{ id: "c1" }, { id: "c2" }] as ConversationDoc[];
const seen: Record<string, SubAccountConversations> = {};
// Every value each consumer rendered, so a one-render flash is caught too.
const renders: Record<string, SubAccountConversations[]> = {};

function Consumer({ name }: { name: string }) {
  seen[name] = useSubAccountConversations();
  (renders[name] ??= []).push(seen[name]);
  return null;
}
const Bare = () => null;

let root: ReturnType<typeof createRoot>;
async function render(...children: ReactNode[]) {
  await act(async () =>
    root.render(createElement(ConversationsProvider, null, ...children)),
  );
}
const consumer = (name: string) => createElement(Consumer, { key: name, name });
const bare = () => createElement(Bare, { key: "bare" });
const latest = () => state.subs[state.subs.length - 1];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.auth = { user: { uid: "u1" }, loading: false };
  state.sub = { subAccountId: "sa1" };
  state.territory = { ready: true, filter: null };
  state.subs = [];
  for (const k of Object.keys(seen)) delete seen[k];
  for (const k of Object.keys(renders)) delete renders[k];
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("downloads nothing until a consumer asks", async () => {
  await render(bare());
  expect(state.subs).toHaveLength(0);
  await render(consumer("a"));
  expect(state.subs).toHaveLength(1);
});

it("loads from the server only, then hands every consumer the same list", async () => {
  await render(consumer("a"), consumer("b"));
  expect(state.subs).toHaveLength(1);
  expect(latest().subAccountId).toBe("sa1");
  // A cache-seeded partial list must never be shown as the whole list.
  expect(latest().opts).toEqual({ waitForServer: true });
  expect(seen.a).toMatchObject({ loading: true, conversations: [] });
  await act(async () => latest().deliver(LIST));
  expect(seen.a).toMatchObject({ loading: false, conversations: LIST, error: null });
  expect(seen.b.conversations).toBe(seen.a.conversations);
});

it("keeps the listener when the page that asked for it unmounts", async () => {
  await render(consumer("visit1"));
  await act(async () => latest().deliver(LIST));
  const first = latest();
  // Leave the inbox for another page, then come back.
  await render(bare());
  expect(first.unsub).not.toHaveBeenCalled();
  await render(consumer("visit2"));
  expect(state.subs).toHaveLength(1);
  expect(seen.visit2).toMatchObject({ loading: false, conversations: LIST });
});

it("passes the territory filter through and re-subscribes when it changes", async () => {
  state.territory = { ready: true, filter: ["global", "t1"] };
  await render(consumer("a"));
  expect(latest().territoryFilter).toEqual(["global", "t1"]);
  await act(async () => latest().deliver(LIST));
  const first = latest();

  const from = renders.a.length;
  state.territory = { ready: true, filter: ["global", "t2"] };
  await render(consumer("a"));
  expect(first.unsub).toHaveBeenCalledTimes(1);
  expect(state.subs).toHaveLength(2);
  expect(latest().territoryFilter).toEqual(["global", "t2"]);
  // The old territory's list is not shown as the new one's, not even for
  // the render before the old listener is torn down.
  for (const r of renders.a.slice(from)) {
    expect(r).toMatchObject({ loading: true, conversations: [] });
  }
});

it("switching back to a territory waits for the server, not the old list", async () => {
  state.territory = { ready: true, filter: ["t1"] };
  await render(consumer("a"));
  await act(async () => latest().deliver(LIST));
  state.territory = { ready: true, filter: ["t2"] };
  await render(consumer("a"));
  // Back to t1 before t2's first answer: t1's old list is not current.
  const from = renders.a.length;
  state.territory = { ready: true, filter: ["t1"] };
  await render(consumer("a"));
  expect(state.subs).toHaveLength(3);
  for (const r of renders.a.slice(from)) {
    expect(r).toMatchObject({ loading: true, conversations: [] });
  }
  await act(async () => latest().deliver(LIST));
  expect(seen.a).toMatchObject({ loading: false, conversations: LIST });
});

it("waits for the territory filter before subscribing", async () => {
  state.territory = { ready: false, filter: null };
  await render(consumer("a"));
  expect(state.subs).toHaveLength(0);
  expect(seen.a.loading).toBe(true);
  state.territory = { ready: true, filter: [] };
  await render(consumer("a"));
  expect(state.subs).toHaveLength(1);
  expect(latest().territoryFilter).toEqual([]);
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
  state.sub = { subAccountId: "sa2" };
  await render(consumer("a"));
  expect(state.subs[0].unsub).toHaveBeenCalledTimes(1);
  expect(latest().subAccountId).toBe("sa2");
  expect(seen.a).toMatchObject({ loading: true, conversations: [] });
});

it("a sub-account switch with no consumer mounted downloads nothing", async () => {
  await render(consumer("a"));
  await render(bare());
  state.sub = { subAccountId: "sa2" };
  await render(bare());
  expect(state.subs[0].unsub).toHaveBeenCalledTimes(1);
  expect(state.subs).toHaveLength(1);
});

it("unsubscribes when the provider unmounts", async () => {
  await render(consumer("a"));
  await act(async () => root.unmount());
  expect(state.subs[0].unsub).toHaveBeenCalledTimes(1);
  root = createRoot(document.createElement("div"));
});

it("a failed listener stops loading, reports the error, and the next visit retries", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await render(consumer("visit1"));
  await act(async () => latest().fail(new Error("permission-denied")));
  expect(seen.visit1.loading).toBe(false);
  expect(seen.visit1.error?.message).toBe("permission-denied");
  await render(bare());
  await render(consumer("visit2"));
  expect(state.subs).toHaveLength(2);
  // The retry loads afresh; it never shows the old failure, not even for
  // the first render before its request lands.
  for (const r of renders.visit2) {
    expect(r).toMatchObject({ loading: true, error: null });
  }
  await act(async () => latest().deliver(LIST));
  expect(seen.visit2).toMatchObject({ loading: false, conversations: LIST, error: null });
});

it("refuses to run outside the provider", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await expect(
    act(async () => root.render(createElement(Consumer, { name: "x" }))),
  ).rejects.toThrow(/ConversationsProvider/);
});

it("signing out forgets the request and the list", async () => {
  await render(consumer("a"));
  await act(async () => latest().deliver(LIST));
  state.auth = { user: null, loading: false };
  await render(bare());
  expect(state.subs[0].unsub).toHaveBeenCalledTimes(1);
  // The same user comes back: no consumer mounted, so nothing downloads.
  state.auth = { user: { uid: "u1" }, loading: false };
  await render(bare());
  expect(state.subs).toHaveLength(1);
  // A visit now waits for the server, not the old list.
  await render(consumer("b"));
  expect(state.subs).toHaveLength(2);
  expect(seen.b).toMatchObject({ loading: true, conversations: [] });
});
