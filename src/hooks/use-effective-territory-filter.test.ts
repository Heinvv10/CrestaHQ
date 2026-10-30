// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  listeners: new Map<string, (snap: unknown) => void>(),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { uid: "user" },
    agencyId: "agency",
    agencyRole: null,
    memberships: [{ subAccountId: "sa", role: "collaborator" }],
    membershipsLoaded: true,
  }),
}));
vi.mock("@/context/sub-account-context", () => ({
  useOptionalSubAccount: () => null,
}));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, ...path: string[]) => path.join("/"),
  onSnapshot: (path: string, fn: (snap: unknown) => void) => {
    m.listeners.set(path, fn);
    return () => m.listeners.delete(path);
  },
}));
import { useEffectiveTerritoryFilter } from "./use-effective-territory-filter";
it("waits for explicit account and membership before exposing a sidebar scope", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  let value: ReturnType<typeof useEffectiveTerritoryFilter>;
  function Harness() {
    value = useEffectiveTerritoryFilter("sa");
    return null;
  }
  try {
    await act(async () => root.render(createElement(Harness)));
    expect(value!.ready).toBe(false);
    await act(async () =>
      m.listeners.get("subAccounts/sa")?.({
        exists: () => true,
        data: () => ({ agencyId: "agency", territoryScopingEnabled: true }),
      })
    );
    expect(value!.ready).toBe(false);
    await act(async () =>
      m.listeners.get("subAccounts/sa/subAccountMembers/user")?.({
        exists: () => true,
        data: () => ({ assignedTerritoryIds: ["north"] }),
      })
    );
    expect(value!).toEqual({ ready: true, filter: ["global", "north"] });
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
