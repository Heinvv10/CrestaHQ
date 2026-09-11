// @vitest-environment jsdom
import { act, createElement, useContext } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  authListener: null as null | ((u: unknown) => void),
}));
vi.mock("@/lib/firebase/client", () => ({
  getFirebaseAuth: () => ({}),
  getFirebaseDb: () => ({}),
  isFirebaseConfigured: () => true,
}));
vi.mock("@/lib/firebase/auth", () => ({ signOutUser: async () => undefined }));
vi.mock("firebase/auth", () => ({
  onAuthStateChanged: (_auth: unknown, fn: (u: unknown) => void) => {
    m.authListener = fn;
    return () => undefined;
  },
}));
vi.mock("firebase/firestore", () => ({
  collection: (_db: unknown, path: string) => path,
  doc: (_db: unknown, ...path: string[]) => path.join("/"),
  getDoc: async (path: string) => ({
    exists: () => true,
    data: () =>
      path === "appConfig/main"
        ? { adminUid: "owner" }
        : { role: "admin", status: "active", primaryAgencyId: "ag_1" },
  }),
  onSnapshot: () => () => undefined,
}));
import { AuthContext, AuthProvider, type AuthContextValue } from "./auth-context";

it("keeps the owner's agencyRole when the forced token refresh fails", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  const root = createRoot(document.createElement("div"));
  let value: AuthContextValue | undefined;
  function Probe() {
    value = useContext(AuthContext);
    return null;
  }
  const firebaseUser = {
    uid: "owner",
    getIdTokenResult: async (force?: boolean) => {
      if (force) throw new Error("network");
      return { claims: { agencyId: "ag_1", agencyRole: "owner" } };
    },
  };
  try {
    await act(async () =>
      root.render(createElement(AuthProvider, null, createElement(Probe))),
    );
    await act(async () => m.authListener?.(firebaseUser));
    expect(value?.loading).toBe(false);
    expect(value?.agencyId).toBe("ag_1");
    expect(value?.agencyRole).toBe("owner");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
