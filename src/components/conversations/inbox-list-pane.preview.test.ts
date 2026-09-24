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
  fetchNewest: vi.fn(),
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
  useSubAccount: () => ({
    subAccountId: "sa1",
    saPath: (p: string) => `/sa/sa1${p}`,
  }),
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

const conv = (id: string, name: string) => ({
  id,
  contactName: name,
  channel: "whatsapp",
  lastMessagePreview: "hi",
  lastMessageAt: new Date("2026-09-24T08:00:00Z"),
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function mount() {
  await act(async () => root.render(createElement(InboxListPane)));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.params = new URLSearchParams();
  state.territoryFilter = null;
  state.deliver = null;
  state.subscribeOpts = null;
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
