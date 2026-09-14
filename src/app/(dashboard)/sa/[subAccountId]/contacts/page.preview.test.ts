// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Contact } from "@/types/contacts";

/**
 * The contacts page paints the newest page while the full list loads — but
 * only when that page is exactly what the table will show (no smart-list
 * filter, no territory narrowing), and the full list always replaces it.
 */
const state = vi.hoisted(() => ({
  filters: { all: [] as unknown[] },
  territoryFilter: null as string[] | null,
  deliver: null as ((list: unknown[]) => void) | null,
  fetchNewest: vi.fn(),
  None: () => null,
  auth: { user: { uid: "u1" }, loading: false },
  sub: {
    subAccountId: "sa1",
    agencyId: "ag1",
    subAccount: {},
    isAdmin: true,
    saPath: (p: string) => `/sa/sa1${p}`,
  },
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/sa/sa1/contacts",
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => state.auth,
}));
vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => state.sub,
}));
vi.mock("@/hooks/use-effective-territory-filter", () => ({
  useEffectiveTerritoryFilter: () => ({ ready: true, filter: state.territoryFilter }),
}));
vi.mock("@/hooks/use-smart-lists", () => ({
  useSmartLists: () => ({
    filters: state.filters,
    setFilters: vi.fn(),
    lists: [],
    activeListId: null,
    setActiveListId: vi.fn(),
    selectList: vi.fn(),
    saveList: vi.fn(),
    renameList: vi.fn(),
    deleteList: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-sub-account-members", () => ({
  useSubAccountMembers: () => ({ members: [] }),
}));
vi.mock("@/lib/firestore/contacts", () => ({
  subscribeToContacts: (_s: unknown, _o: unknown, cb: (l: unknown[]) => void) => {
    state.deliver = cb;
    return () => undefined;
  },
  fetchNewestContacts: (...a: unknown[]) => state.fetchNewest(...a),
}));
vi.mock("@/lib/firestore/territories", () => ({
  subscribeToTerritories: () => () => undefined,
}));
// Dialogs and toolbars unrelated to the list.
vi.mock("@/components/contacts/add-contact-modal", () => ({ AddContactModal: state.None }));
vi.mock("@/components/contacts/import-contacts-dialog", () => ({ ImportContactsDialog: state.None }));
vi.mock("@/components/contacts/bulk-email-dialog", () => ({ BulkEmailDialog: state.None }));
vi.mock("@/components/contacts/bulk-call-dialog", () => ({ BulkCallDialog: state.None }));
vi.mock("@/components/contacts/contact-filters-panel", () => ({ ContactFiltersPanel: state.None }));
vi.mock("@/components/contacts/smart-list-tabs", () => ({ SmartListTabs: state.None }));
vi.mock("@/components/contacts/bulk-actions-bar", () => ({ BulkActionsBar: state.None }));

import ContactsPage from "./page";

function contacts(prefix: string, n: number): Contact[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    name: `${prefix} ${i}`,
    email: "",
    phone: "",
    company: "",
    address: "",
    source: "manual",
    tags: [],
    pipelineStage: null,
    attribution: null,
    createdAt: new Date(Date.UTC(2026, 0, 1) + (n - i) * 60_000),
  })) as unknown as Contact[];
}

let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.filters = { all: [] };
  state.territoryFilter = null;
  state.deliver = null;
  state.fetchNewest.mockReset();
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
});

const rows = () => el.querySelectorAll("tbody tr").length;
const loadingNote = () => el.textContent?.includes("Loading all contacts") ?? false;
const skeleton = () => el.querySelectorAll(".animate-pulse").length > 0;

it("paints the newest page first, then the full list replaces it", async () => {
  state.fetchNewest.mockResolvedValue(contacts("Preview", 3));
  await act(async () => root.render(createElement(ContactsPage)));
  expect(state.fetchNewest).toHaveBeenCalledWith(
    { agencyId: "ag1", subAccountId: "sa1" },
    100,
  );
  expect(rows()).toBe(3);
  expect(loadingNote()).toBe(true);

  await act(async () => state.deliver!(contacts("Full", 5)));
  expect(rows()).toBe(5);
  expect(loadingNote()).toBe(false);
  expect(el.textContent).not.toContain("Preview");
});

it("shows the skeleton, not a preview, while a smart-list filter is active", async () => {
  state.filters = { all: [{ field: "tags", op: "contains", value: "x" }] };
  state.fetchNewest.mockResolvedValue(contacts("Preview", 3));
  await act(async () => root.render(createElement(ContactsPage)));
  expect(state.fetchNewest).not.toHaveBeenCalled();
  expect(rows()).toBe(0);
  expect(skeleton()).toBe(true);
});

it("never previews for a territory-scoped viewer", async () => {
  state.territoryFilter = ["t1"];
  state.fetchNewest.mockResolvedValue(contacts("Preview", 3));
  await act(async () => root.render(createElement(ContactsPage)));
  expect(state.fetchNewest).not.toHaveBeenCalled();
  expect(skeleton()).toBe(true);
});

it("a failed preview falls back to the skeleton until the list arrives", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  state.fetchNewest.mockRejectedValue(new Error("FAILED_PRECONDITION"));
  await act(async () => root.render(createElement(ContactsPage)));
  expect(skeleton()).toBe(true);
  await act(async () => state.deliver!(contacts("Full", 2)));
  expect(rows()).toBe(2);
});
