// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * "Copy link" on a pending invite: the server keeps only the token's hash, so
 * the link can't be rebuilt client-side. Copying re-issues the invite (same
 * role + territories) and copies the URL the server returns — a link built
 * from the email alone would be refused at signup.
 */

const t = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: t }));
vi.mock("firebase/firestore", () => ({
  collection: () => ({}),
  query: () => ({}),
  where: () => ({}),
  // Both listeners get the one pending invite; the members listener drops it
  // (no active status).
  onSnapshot: (_q: unknown, cb: (s: unknown) => void) => {
    cb({
      docs: [
        {
          id: "inv_1",
          data: () => ({ email: "p@example.com", subAccountRole: "collaborator", assignedTerritoryIds: ["t1"] }),
        },
      ],
    });
    return () => undefined;
  },
}));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
vi.mock("@/lib/firestore/territories", () => ({ subscribeToTerritories: () => () => undefined }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "admin1" }, agencyRole: null }) }));
vi.mock("@/hooks/use-agency-owner-uid", () => ({ useAgencyOwnerUid: () => null }));
vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({ subAccountId: "sa1", subAccount: {}, isAdmin: true }),
}));
vi.mock("@/components/settings/manage-members-dialog", () => ({ ManageMembersDialog: () => null }));
vi.mock("@/components/settings/territory-multi-select", () => ({ TerritoryMultiSelect: () => null }));

const { SubAccountMembersSection } = await import("./sub-account-members-section");

const fetchMock = vi.fn();
const clipboard = vi.fn(async (_text: string) => undefined);
let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(navigator, "clipboard", { value: { writeText: clipboard }, configurable: true });
  fetchMock.mockReset();
  clipboard.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(SubAccountMembersSection)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("re-issues the invite and copies the tokenised URL the server returns", async () => {
  const url = "https://app/signup?email=p%40example.com&invite=fresh";
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, inviteUrl: url, mailed: true }) });
  const button = container.querySelector('[aria-label="Copy invite link"]') as HTMLButtonElement;
  await act(async () => button.click());

  expect(fetchMock).toHaveBeenCalledWith("/api/sub-accounts/sa1/invite", expect.anything());
  expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
    email: "p@example.com",
    role: "collaborator",
    assignedTerritoryIds: ["t1"],
  });
  expect(clipboard).toHaveBeenCalledWith(url);
});
