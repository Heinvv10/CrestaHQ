// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * The inbox paints the newest page while the full list loads — but only
 * when that page is exactly what the list will show (default filters, no
 * territory narrowing, no search), and the full list always replaces it.
 */
const state = vi.hoisted(() => ({
  params: new URLSearchParams(),
  routeParams: {},
  router: { replace: () => undefined },
  auth: { user: { uid: "u1" }, loading: false },
  territoryFilter: null as string[] | null,
  deliver: null as ((list: unknown[]) => void) | null,
  subscribeOpts: null as unknown,
  subscribeCount: 0,
  fetchNewest: vi.fn(),
  sub: {
    subAccountId: "sa1",
    saPath: (p: string) => `/sa/sa1${p}`,
  },
}));

vi.mock("next/navigation", () => ({
  // Stable objects, as Next returns: a fresh one per render loops the pane's
  // URL-sync effect.
  useParams: () => state.routeParams,
  useSearchParams: () => state.params,
  usePathname: () => "/sa/sa1/conversations",
  useRouter: () => state.router,
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => state.auth,
}));
vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => state.sub,
}));
vi.mock("@/hooks/use-effective-territory-filter", () => ({
  useEffectiveTerritoryFilter: () => ({
    ready: true,
    filter: state.territoryFilter,
  }),
}));
vi.mock("@/lib/firestore/conversations", () => ({
  subscribeToConversations: (
    _sa: unknown,
    cb: (l: unknown[]) => void,
    _err: unknown,
    _territory: unknown,
    opts: unknown
  ) => {
    state.subscribeOpts = opts;
    state.subscribeCount += 1;
    state.deliver = cb;
    return () => undefined;
  },
  fetchNewestConversations: (...a: unknown[]) => state.fetchNewest(...a),
}));
vi.mock("@/components/conversations/inbox-toolbar", () => ({
  InboxToolbar: () => null,
}));
vi.mock("@/components/conversations/star-toggle", () => ({
  StarToggle: () => null,
}));

import { InboxListPane } from "./inbox-list-pane";
import { ConversationsProvider } from "@/context/conversations-context";
import { SLOW_AFTER_MS } from "@/hooks/use-loading-hint";

const conv = (id: string, name: string) => ({
  id,
  contactName: name,
  channel: "whatsapp",
  lastMessagePreview: "hi",
  lastMessageAt: new Date("2026-09-24T08:00:00Z"),
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

// The sub-account layout mounts the shared conversations provider above
// every page; leaving the inbox unmounts the pane but not the provider.
async function mount() {
  await act(async () =>
    root.render(
      createElement(ConversationsProvider, null, createElement(InboxListPane))
    )
  );
}
async function leave() {
  await act(async () =>
    root.render(createElement(ConversationsProvider, null))
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.params = new URLSearchParams();
  state.territoryFilter = null;
  state.deliver = null;
  state.subscribeOpts = null;
  state.subscribeCount = 0;
  state.fetchNewest.mockReset();
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("shows the newest page while loading, then the full list replaces it", async () => {
  state.fetchNewest.mockResolvedValue([conv("c1", "Preview Person")]);
  await mount();
  expect(state.fetchNewest).toHaveBeenCalledWith("sa1", 100);
  expect(host.textContent).toContain("Preview Person");
  expect(host.textContent).toContain("Loading all conversations");

  await act(async () =>
    state.deliver!([conv("c1", "Preview Person"), conv("c2", "Full Person")])
  );
  expect(host.textContent).toContain("Full Person");
  expect(host.textContent).not.toContain("Loading all conversations");
});

it("a revisit shows the list at once: no new download, no preview fetch", async () => {
  state.fetchNewest.mockResolvedValue([conv("c1", "Preview Person")]);
  await mount();
  await act(async () => state.deliver!([conv("c2", "Full Person")]));
  expect(state.subscribeCount).toBe(1);
  expect(state.fetchNewest).toHaveBeenCalledTimes(1);

  await leave();
  expect(host.textContent).toBe("");
  await mount();
  expect(host.textContent).toContain("Full Person");
  expect(host.textContent).not.toContain("Loading all conversations");
  expect(state.subscribeCount).toBe(1);
  expect(state.fetchNewest).toHaveBeenCalledTimes(1);
});

it("holds the full listener until the server answers", async () => {
  state.fetchNewest.mockResolvedValue([]);
  await mount();
  expect(state.subscribeOpts).toEqual({ waitForServer: true });
});

it("no preview under territory narrowing", async () => {
  state.territoryFilter = ["north"];
  await mount();
  expect(state.fetchNewest).not.toHaveBeenCalled();
});

it("no preview when the URL carries a filter", async () => {
  state.params = new URLSearchParams("tab=unread");
  await mount();
  expect(state.fetchNewest).not.toHaveBeenCalled();
});

/**
 * The full list waits for the server, so offline or stalled it would load
 * silently forever. It must say why — for the preview AND the skeleton — and
 * the message must go once the list arrives.
 */
const status = () => host.querySelector('[role="status"]')?.textContent ?? "";

it("says offline while the list cannot load, and clears once it arrives", async () => {
  state.fetchNewest.mockReturnValue(new Promise(() => undefined));
  await mount();
  await act(async () => {
    window.dispatchEvent(new Event("offline"));
  });
  expect(status()).toContain("You're offline");
  await act(async () => {
    window.dispatchEvent(new Event("online"));
  });
  expect(status()).toBe("");
  await act(async () => state.deliver!([conv("c1", "Full Person")]));
  expect(status()).toBe("");
  expect(host.textContent).toContain("Full Person");
});

it("says the load is slow after the threshold, over the preview too", async () => {
  vi.useFakeTimers();
  try {
    state.fetchNewest.mockResolvedValue([conv("c1", "Preview Person")]);
    await mount();
    expect(status()).toBe("");
    await act(async () => vi.advanceTimersByTime(SLOW_AFTER_MS));
    expect(status()).toContain("Still loading conversations");
    expect(host.textContent).toContain("Preview Person");
    await act(async () => state.deliver!([conv("c2", "Full Person")]));
    expect(status()).toBe("");
  } finally {
    vi.useRealTimers();
  }
});

it("a territory-scoped viewer (skeleton, no preview) is told too", async () => {
  vi.useFakeTimers();
  try {
    state.territoryFilter = ["north"];
    await mount();
    await act(async () => vi.advanceTimersByTime(SLOW_AFTER_MS));
    expect(status()).toContain("Still loading conversations");
  } finally {
    vi.useRealTimers();
  }
});

it("a restarted load (territory change) restarts the slow timer", async () => {
  vi.useFakeTimers();
  try {
    state.territoryFilter = ["north"];
    await mount();
    await act(async () => vi.advanceTimersByTime(SLOW_AFTER_MS));
    expect(status()).toContain("Still loading conversations");
    state.territoryFilter = ["south"];
    await mount();
    expect(status()).toBe("");
  } finally {
    vi.useRealTimers();
  }
});
