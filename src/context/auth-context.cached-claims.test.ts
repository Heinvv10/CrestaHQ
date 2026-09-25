// @vitest-environment jsdom
import { act, createElement, useContext } from "react";
import { createRoot } from "react-dom/client";
import type { ParsedToken } from "firebase/auth";
import { afterEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  authListener: null as null | ((u: unknown) => void),
  userDoc: { role: "admin", status: "active", primaryAgencyId: "ag_1" } as Record<string, unknown>,
  // When set, the users/{uid} read waits on this before it resolves.
  userDocGate: null as null | Promise<void>,
  userDocReads: 0,
  // Rejections to hand out, one per read of the user doc, before it succeeds.
  getDocFailures: [] as unknown[],
  listens: [] as { next: (snap: unknown) => void; unsub: () => void }[],
  signOut: vi.fn(async () => undefined),
}));
vi.mock("@/lib/firebase/client", () => ({
  getFirebaseAuth: () => ({}),
  getFirebaseDb: () => ({}),
  isFirebaseConfigured: () => true,
}));
vi.mock("@/lib/firebase/auth", () => ({ signOutUser: m.signOut }));
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
    if (path.startsWith("users/")) {
      m.userDocReads++;
      if (m.getDocFailures.length > 0) throw m.getDocFailures.shift();
      if (m.userDocGate) await m.userDocGate;
    }
    return {
      exists: () => true,
      data: () => (path === "appConfig/main" ? { adminUid: "owner" } : m.userDoc),
    };
  },
  onSnapshot: (_q: unknown, next: (snap: unknown) => void) => {
    const listen = { next, unsub: vi.fn() };
    m.listens.push(listen);
    return listen.unsub;
  },
}));
import { AuthContext, AuthProvider, type AuthContextValue } from "./auth-context";

type Claims = ParsedToken;
const never = () => new Promise<never>(() => undefined);
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A user whose cached token holds `cached` and whose forced refresh is `refresh()`. */
function tokenUser(uid: string, cached: Claims, refresh: () => Promise<Claims>) {
  return {
    uid,
    getIdTokenResult: vi.fn(async (force?: boolean) => ({
      claims: force ? await refresh() : cached,
    })),
  };
}

const activeOwner = { status: "active", agencyId: "ag_1", agencyRole: "owner" };
const membershipSnap = {
  docs: [{ id: "sa_1", data: () => ({ subAccountId: "sa_1", agencyId: "ag_1", name: "One" }) }],
};

/**
 * Runs `fn` inside act and lets the promise chains it starts settle, without
 * awaiting `fn`'s own promise — onUser may be parked on a pending refresh.
 */
async function step(fn: () => unknown): Promise<void> {
  await act(async () => {
    void fn();
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

let unmount: () => Promise<void> = async () => undefined;
async function mount(firebaseUser: unknown): Promise<() => AuthContextValue | undefined> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  const root = createRoot(document.createElement("div"));
  let value: AuthContextValue | undefined;
  function Probe() {
    value = useContext(AuthContext);
    return null;
  }
  await act(async () => root.render(createElement(AuthProvider, null, createElement(Probe))));
  await step(() => m.authListener?.(firebaseUser));
  unmount = () => act(async () => root.unmount());
  return () => value;
}

afterEach(async () => {
  await unmount();
  m.userDoc = { role: "admin", status: "active", primaryAgencyId: "ag_1" };
  m.userDocGate = null;
  m.userDocReads = 0;
  m.getDocFailures = [];
  m.listens = [];
  m.signOut.mockClear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("does not wait on the forced refresh when the cached claims are active", async () => {
  const user = tokenUser("owner", activeOwner, never);
  const value = await mount(user);
  expect(value()?.loading).toBe(false);
  expect(value()?.agencyId).toBe("ag_1");
  expect(value()?.agencyRole).toBe("owner");
  // The refresh still runs, in the background.
  expect(user.getIdTokenResult).toHaveBeenCalledWith(true);
});

it("waits for the forced refresh when the cached token has no active status", async () => {
  const refresh = deferred<Claims>();
  const value = await mount(tokenUser("owner", {}, () => refresh.promise));
  expect(value()?.loading).toBe(true);
  expect(m.userDocReads).toBe(0);
  await step(() => refresh.resolve(activeOwner));
  expect(value()?.loading).toBe(false);
  expect(value()?.agencyRole).toBe("owner");
});

it("applies a background refresh whose agencyRole differs from the cached one", async () => {
  const refresh = deferred<Claims>();
  const cached = { status: "active", agencyId: "ag_1", agencyRole: null };
  const value = await mount(tokenUser("owner", cached, () => refresh.promise));
  expect(value()?.loading).toBe(false);
  expect(value()?.agencyRole).toBeNull();
  await step(() => refresh.resolve(activeOwner));
  expect(value()?.agencyRole).toBe("owner");
});

it("uses a background refresh that lands before the user doc resolves", async () => {
  const gate = deferred<void>();
  m.userDocGate = gate.promise;
  const cached = { status: "active", agencyId: "ag_1", agencyRole: null };
  const value = await mount(tokenUser("owner", cached, async () => activeOwner));
  await step(() => gate.resolve());
  expect(value()?.agencyRole).toBe("owner");
});

it("keeps the cached owner claims when the background refresh fails", async () => {
  const value = await mount(
    tokenUser("owner", activeOwner, async () => {
      throw new Error("network");
    }),
  );
  expect(value()?.loading).toBe(false);
  expect(value()?.agencyId).toBe("ag_1");
  expect(value()?.agencyRole).toBe("owner");
});

it("ignores a background refresh from a previous user", async () => {
  const refreshA = deferred<Claims>();
  const value = await mount(tokenUser("a", { ...activeOwner, agencyRole: null }, () => refreshA.promise));
  const cachedB = { status: "active", agencyId: "ag_2", agencyRole: null };
  await step(() => m.authListener?.(tokenUser("b", cachedB, never)));
  await step(() => refreshA.resolve(activeOwner));
  expect(value()?.agencyRole).toBeNull();
  expect(value()?.agencyId).toBe("ag_2");
});

it("starts the memberships listen before the user doc resolves, publishing only after", async () => {
  const gate = deferred<void>();
  m.userDocGate = gate.promise;
  const value = await mount(tokenUser("owner", activeOwner, never));
  expect(m.userDocReads).toBe(1);
  expect(m.listens).toHaveLength(1);
  await step(() => m.listens[0].next(membershipSnap));
  expect(value()?.memberships).toEqual([]);
  expect(value()?.membershipsLoaded).toBe(false);
  await step(() => gate.resolve());
  expect(value()?.memberships.map((s) => s.subAccountId)).toEqual(["sa_1"]);
  expect(value()?.membershipsLoaded).toBe(true);
});

it("signs a removed user out, drops the listen and never publishes its memberships", async () => {
  const gate = deferred<void>();
  m.userDocGate = gate.promise;
  m.userDoc = { role: "admin", status: "removed", primaryAgencyId: "ag_1" };
  const value = await mount(tokenUser("owner", activeOwner, never));
  await step(() => m.listens[0].next(membershipSnap));
  await step(() => gate.resolve());
  expect(m.signOut).toHaveBeenCalled();
  expect(m.listens[0].unsub).toHaveBeenCalled();
  expect(value()?.user).toBeNull();
  expect(value()?.status).toBe("removed");
  expect(value()?.agencyRole).toBeNull();
  expect(value()?.memberships).toEqual([]);
  // A snapshot arriving after the removal is still not published.
  await step(() => m.listens[0].next(membershipSnap));
  expect(value()?.memberships).toEqual([]);
});

it("drops the first listen when a dropped connection forces a retry", async () => {
  vi.useFakeTimers();
  m.getDocFailures = [Object.assign(new Error("offline"), { code: "unavailable" })];
  const value = await mount(tokenUser("owner", activeOwner, never));
  expect(value()?.loading).toBe(true);
  expect(m.listens[0].unsub).toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(value()?.loading).toBe(false);
  expect(m.listens).toHaveLength(2);
  await step(() => m.listens[1].next(membershipSnap));
  expect(value()?.memberships.map((s) => s.subAccountId)).toEqual(["sa_1"]);
});
