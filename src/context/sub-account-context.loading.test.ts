// @vitest-environment jsdom
import { act, createElement, type FC, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * `loading` stays true from the moment the workspace listener attaches until
 * its first snapshot — including when the provider first rendered before the
 * user was known, so a gate never reads as off for a doc that hasn't arrived.
 */

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
const auth = vi.hoisted(() => ({
  user: null as { uid: string } | null,
  agencyId: "ag1",
  agencyRole: "owner",
  memberships: [] as never[],
  membershipsLoaded: true,
  loading: false,
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
const snap = vi.hoisted(() => ({ emit: null as ((s: unknown) => void) | null }));
vi.mock("firebase/firestore", () => ({
  doc: () => ({}),
  onSnapshot: (_ref: unknown, cb: (s: unknown) => void) => {
    snap.emit = cb;
    return () => undefined;
  },
}));

const { SubAccountProvider, useSubAccount } = await import("./sub-account-context");

let container: HTMLDivElement;
let root: Root;

function Consumer() {
  const { loading, subAccount } = useSubAccount();
  return createElement("p", null, `${loading ? "loading" : "ready"}:${subAccount ? "doc" : "none"}`);
}

async function render() {
  await act(async () =>
    root.render(
      createElement(
        SubAccountProvider as FC<{ subAccountId: string; children?: ReactNode }>,
        { subAccountId: "sa1" },
        createElement(Consumer),
      ),
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ pipelines: [] }) })));
  auth.user = null;
  snap.emit = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("is loading between the user arriving and the first snapshot", async () => {
  await render();
  expect(snap.emit).toBeNull();

  auth.user = { uid: "u1" };
  await render();
  expect(snap.emit).not.toBeNull();
  expect(container.textContent).toBe("loading:none");

  await act(async () => snap.emit!({ exists: () => true, data: () => ({ agencyId: "ag1", name: "SA" }) }));
  expect(container.textContent).toBe("ready:doc");
});
