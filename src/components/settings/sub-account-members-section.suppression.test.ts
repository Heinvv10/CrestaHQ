// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * What the inviter sees when the invitee's address is suppressed: access is
 * granted, and a warning says the email was withheld and why — not the
 * "link copied (set RESEND_API_KEY…)" success meant for unconfigured email.
 */

const t = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: t }));
vi.mock("firebase/firestore", () => ({
  collection: () => ({}),
  query: () => ({}),
  where: () => ({}),
  onSnapshot: () => () => undefined,
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
const clipboard = vi.fn(async () => undefined);
let container: HTMLDivElement;
let root: Root;
const SUPPRESSED =
  "Not sent: new@example.com is on this workspace's email suppression list (hard bounce).";

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(navigator, "clipboard", { value: { writeText: clipboard }, configurable: true });
  fetchMock.mockReset();
  clipboard.mockClear();
  Object.values(t).forEach((f) => f.mockClear());
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

async function invite(response: Record<string, unknown>) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, ...response }) });
  const input = container.querySelector("#invite-email") as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, "new@example.com");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
}

it("warns that a suppressed invitee was not emailed, and why", async () => {
  await invite({ mailed: false, mailSuppressed: true, mailError: SUPPRESSED, inviteUrl: "https://x/signup" });
  expect(t.warning).toHaveBeenCalledWith(expect.stringContaining("Invite created, but not emailed."));
  expect(t.warning).toHaveBeenCalledWith(expect.stringContaining("suppression list"));
  expect(t.success).not.toHaveBeenCalled();
  expect(clipboard).not.toHaveBeenCalled();
});

it("warns the same way when an existing user was added directly", async () => {
  await invite({ added: true, role: "collaborator", mailed: false, mailSuppressed: true, mailError: SUPPRESSED });
  expect(t.warning).toHaveBeenCalledWith(
    expect.stringContaining("Added new@example.com as collaborator, but not emailed.")
  );
  expect(t.success).not.toHaveBeenCalled();
});

it("keeps the normal success toast for an emailed invite", async () => {
  await invite({ mailed: true, mailSuppressed: false });
  expect(t.success).toHaveBeenCalledWith("Invite emailed to new@example.com");
  expect(t.warning).not.toHaveBeenCalled();
});
