// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * The sidebar's Agency → Approvals entry (A5): the owner's only. Shown with
 * a badge of open rows while the agency's Agent API switch is on; with it
 * off, shown only while unsettled rows still need settling (the hook is
 * asked for `unsettled` then), else hidden. Never asked for a non-owner.
 */

const state = vi.hoisted(() => ({
  role: "owner" as string,
  switchOn: true,
  counts: { open: 0, unsettled: 0 } as Record<string, number>,
  modes: [] as Array<string | null>,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/agency", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("firebase/firestore", () => ({ doc: () => ({}), onSnapshot: () => () => undefined }));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
vi.mock("@/lib/firebase/auth", () => ({ signOutUser: async () => undefined }));
vi.mock("@/hooks/use-standalone", () => ({ useIsStandalone: () => false }));
vi.mock("@/hooks/use-due-today", () => ({ useDueTodayCount: () => 0 }));
vi.mock("@/hooks/use-unread-conversations", () => ({ useUnreadConversationsCount: () => 0 }));
vi.mock("@/hooks/use-open-approvals", () => ({ useOpenApprovalsCount: () => 0 }));
vi.mock("@/hooks/use-active-sub-account-id", () => ({ useActiveSubAccountId: () => ({ subAccountId: null, agencyId: "ag1" }) }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ agencyRole: state.role, memberships: [{ subAccountId: "sa1" }, { subAccountId: "sa2" }], loading: false }),
}));
vi.mock("@/hooks/use-agency", () => ({
  useAgency: () => ({ name: "Agency", logoUrl: null, agencyAssistantEnabled: false, agentApiEnabled: state.switchOn }),
}));
vi.mock("@/hooks/use-agency-open-approvals", () => ({
  useAgencyOpenApprovalsCount: (mode: string | null) => {
    state.modes.push(mode);
    return mode ? (state.counts[mode] ?? 0) : 0;
  },
}));
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: unknown; className?: string }) =>
    createElement("a", { href, className }, children as never),
}));

const { Sidebar } = await import("./sidebar");

let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => {
    root.render(createElement(Sidebar, { open: false, onOpenChange: () => undefined }));
    await new Promise((r) => setTimeout(r, 0));
  });
}
const link = () => container.querySelector('a[href="/agency/approvals"]');

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.modes = [];
  state.role = "owner";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("switch on: the entry shows with a badge of open rows", async () => {
  state.switchOn = true;
  state.counts = { open: 4, unsettled: 1 };
  await render();
  expect(link()!.textContent).toContain("4");
  expect(state.modes).toContain("open");
});

it("switch off with unsettled rows: the entry still shows (asking for unsettled only)", async () => {
  state.switchOn = false;
  state.counts = { open: 0, unsettled: 2 };
  await render();
  expect(state.modes).toContain("unsettled");
  expect(state.modes).not.toContain("open");
  expect(link()!.textContent).toContain("2");
});

it("switch off with nothing unsettled: hidden", async () => {
  state.switchOn = false;
  state.counts = { open: 5, unsettled: 0 };
  await render();
  expect(link()).toBeNull();
});

it("not the owner: never asked, never shown", async () => {
  state.role = "admin";
  state.switchOn = true;
  state.counts = { open: 3, unsettled: 3 };
  await render();
  expect(state.modes.every((m) => m === null)).toBe(true);
  expect(link()).toBeNull();
});
