// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * The sidebar's Approvals entry: shown with its badge while the Agent API
 * gate is on; with the gate off, shown only while unsettled rows still need
 * settling (the hook is asked for `unsettled` then), else hidden.
 */

const state = vi.hoisted(() => ({
  gate: true as boolean,
  counts: { open: 0, unsettled: 0 } as Record<string, number>,
  modes: [] as Array<string | null>,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/sa/sa1/dashboard", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("firebase/firestore", () => ({
  doc: () => ({}),
  onSnapshot: (_ref: unknown, next: (s: { data: () => Record<string, unknown> }) => void) => {
    next({ data: () => ({ agentApiEnabledByAgency: state.gate }) });
    return () => undefined;
  },
}));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
vi.mock("@/lib/firebase/auth", () => ({ signOutUser: async () => undefined }));
vi.mock("@/hooks/use-standalone", () => ({ useIsStandalone: () => false }));
vi.mock("@/hooks/use-due-today", () => ({ useDueTodayCount: () => 0 }));
vi.mock("@/hooks/use-unread-conversations", () => ({ useUnreadConversationsCount: () => 0 }));
vi.mock("@/hooks/use-active-sub-account-id", () => ({ useActiveSubAccountId: () => ({ subAccountId: "sa1", agencyId: "ag1" }) }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ agencyRole: "none", memberships: [{ subAccountId: "sa1", name: "Fixture" }], loading: false }),
}));
vi.mock("@/hooks/use-agency", () => ({ useAgency: () => ({ name: "Agency", logoUrl: null, agencyAssistantEnabled: false }) }));
vi.mock("@/hooks/use-open-approvals", () => ({
  useOpenApprovalsCount: (_sub: string | null, mode: string | null) => {
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
const approvalsLink = () => container.querySelector('a[href="/sa/sa1/approvals"]');

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.modes = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("gate on: the entry shows with a badge of pending + unsettled", async () => {
  state.gate = true;
  state.counts = { open: 3, unsettled: 1 };
  await render();
  expect(approvalsLink()).not.toBeNull();
  expect(approvalsLink()!.textContent).toContain("3");
  expect(state.modes).toContain("open");
});

it("gate off with unsettled rows: the entry still shows (asking for unsettled only)", async () => {
  state.gate = false;
  state.counts = { open: 0, unsettled: 2 };
  await render();
  expect(state.modes).toContain("unsettled");
  expect(state.modes).not.toContain("open");
  expect(approvalsLink()!.textContent).toContain("2");
});

it("gate off with nothing unsettled: the entry is hidden", async () => {
  state.gate = false;
  state.counts = { open: 5, unsettled: 0 };
  await render();
  expect(approvalsLink()).toBeNull();
});
