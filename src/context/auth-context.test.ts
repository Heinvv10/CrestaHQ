// @vitest-environment jsdom
import { act, createElement, useContext } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  authListener: null as null | ((u: unknown) => void),
  // Rejections to hand out, one per read of the user doc, before it succeeds.
  getDocFailures: [] as unknown[],
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
  getDoc: async (path: string) => {
    if (path.startsWith("users/") && m.getDocFailures.length > 0) {
      throw m.getDocFailures.shift();
    }
    return {
      exists: () => true,
      data: () =>
        path === "appConfig/main"
          ? { adminUid: "owner" }
          : { role: "admin", status: "active", primaryAgencyId: "ag_1" },
    };
  },
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

/** Firestore's rejection for a read made while the client is offline. */
const offline = () =>
  Object.assign(new Error("Failed to get document because the client is offline."), {
    code: "unavailable",
  });

const owner = {
  uid: "owner",
  getIdTokenResult: async () => ({ claims: { agencyId: "ag_1", agencyRole: "owner" } }),
};

async function mountWithUser(): Promise<{
  value: () => AuthContextValue | undefined;
  unmount: () => Promise<void>;
}> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  const root = createRoot(document.createElement("div"));
  let value: AuthContextValue | undefined;
  function Probe() {
    value = useContext(AuthContext);
    return null;
  }
  await act(async () =>
    root.render(createElement(AuthProvider, null, createElement(Probe))),
  );
  await act(async () => m.authListener?.(owner));
  return { value: () => value, unmount: () => act(async () => root.unmount()) };
}

afterEach(() => {
  m.getDocFailures = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("stays loading through a dropped connection, then resolves the agency", async () => {
  vi.useFakeTimers();
  m.getDocFailures = [offline(), offline()];
  const { value, unmount } = await mountWithUser();
  try {
    // Nothing may decide access while the reads are still being retried.
    expect(value()?.loading).toBe(true);
    expect(value()?.membershipsLoaded).toBe(false);
    expect(value()?.agencyId).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(value()?.loading).toBe(true);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(value()?.loading).toBe(false);
    expect(value()?.agencyId).toBe("ag_1");
    expect(value()?.agencyRole).toBe("owner");
  } finally {
    await unmount();
  }
});

it("does not retry an error that is not a dropped connection", async () => {
  vi.useFakeTimers();
  m.getDocFailures = [
    Object.assign(new Error("Missing or insufficient permissions."), {
      code: "permission-denied",
    }),
  ];
  const { value, unmount } = await mountWithUser();
  try {
    expect(value()?.loading).toBe(false);
    expect(value()?.membershipsLoaded).toBe(true);
    expect(value()?.agencyId).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(value()?.agencyId).toBeNull();
  } finally {
    await unmount();
  }
});

it("gives up after the last retry instead of loading forever", async () => {
  vi.useFakeTimers();
  // One initial attempt plus six retries.
  m.getDocFailures = Array.from({ length: 7 }, offline);
  const { value, unmount } = await mountWithUser();
  try {
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(value()?.loading).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(value()?.loading).toBe(false);
    expect(value()?.membershipsLoaded).toBe(true);
    expect(value()?.agencyId).toBeNull();
    expect(m.getDocFailures).toHaveLength(0);
  } finally {
    await unmount();
  }
});
