// @vitest-environment jsdom
import { act, createElement, type FC, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * The pipelines the provider hands out. A failed load must NOT collapse the
 * list to the synthetic default (every non-default pipeline's deals would
 * vanish from the board): it keeps the last-known list and toasts.
 */

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
// Stable identities: the provider's effects key on `user`, so a fresh
// object per render would re-subscribe forever.
const auth = vi.hoisted(() => ({
  user: { uid: "u1" },
  agencyId: "ag1",
  agencyRole: "owner",
  memberships: [] as never[],
  membershipsLoaded: true,
  loading: false,
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
vi.mock("firebase/firestore", () => ({
  doc: () => ({}),
  onSnapshot: (_ref: unknown, cb: (snap: unknown) => void) => {
    cb({ exists: () => true, data: () => ({ agencyId: "ag1", name: "SA" }) });
    return () => undefined;
  },
}));

const { SubAccountProvider, useSubAccount } = await import("./sub-account-context");

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();
let refresh: () => Promise<void> = async () => undefined;

function Consumer() {
  const ctx = useSubAccount();
  refresh = ctx.refreshPipelines;
  return createElement("p", null, ctx.pipelines.map((p) => p.name).join(","));
}

const pipeline = (id: string, name: string, isDefault = false) => ({
  id, name, isDefault, stages: [{ id: "s", label: "S", tone: "" }],
  agencyId: "ag1", subAccountId: "sa1", createdByUid: "u1", createdAt: null, updatedAt: null,
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  toast.error.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

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

it("a failed load keeps the last-known pipelines and toasts", async () => {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ pipelines: [pipeline("default", "Default", true), pipeline("p2", "Renewals")] }),
  });
  await render();
  expect(container.textContent).toBe("Default,Renewals");
  expect(toast.error).not.toHaveBeenCalled();

  fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
  await act(async () => refresh());
  expect(container.textContent).toBe("Default,Renewals");
  expect(toast.error).toHaveBeenCalledTimes(1);

  fetchMock.mockRejectedValueOnce(new TypeError("network down"));
  await act(async () => refresh());
  expect(container.textContent).toBe("Default,Renewals");
  expect(toast.error).toHaveBeenCalledTimes(2);
});

it("a cold-start failure falls back to the synthetic default and toasts", async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
  await render();
  expect(container.textContent).toBe("Default");
  expect(toast.error).toHaveBeenCalledTimes(1);
});
