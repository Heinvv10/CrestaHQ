"use client";

import {
  createContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
} from "firebase/firestore";
import {
  getFirebaseAuth,
  getFirebaseDb,
  isFirebaseConfigured,
} from "@/lib/firebase/client";
import { signOutUser } from "@/lib/firebase/auth";
import {
  loadIdTokenClaims,
  readActiveCachedClaims,
} from "@/lib/firebase/id-token-claims";
import type {
  AgencyRole,
  AppConfig,
  MemberStatus,
  Role,
  UserDoc,
  UserSubAccountMembership,
} from "@/types";

export interface AuthContextValue {
  user: User | null;
  loading: boolean;
  /**
   * Legacy single-tenant pointer — the workspace owner's uid (the first
   * signup). Still consumed by the existing dashboard pages until Phase 2's
   * routing migration. Going forward, scope reads/writes by `subAccountId`
   * via `useSubAccount()` instead.
   */
  adminUid: string | null;
  /** Legacy role claim (admin | collaborator). Sub-account roles are per-sub-account. */
  role: Role | null;
  status: MemberStatus | null;
  /** Tenancy: the user's home agency. */
  agencyId: string | null;
  /** Tenancy: agency-level role (only owners are populated in v1). */
  agencyRole: AgencyRole | null;
  /**
   * Per-user denormalized index of every sub-account this user is a member
   * of. Powers the sub-account switcher dropdown. Empty array while loading.
   */
  memberships: UserSubAccountMembership[];
  /**
   * False until the membership subscription has delivered its first
   * snapshot. `loading` flips to false as soon as the auth token + user doc
   * resolve — which can be BEFORE memberships arrive — so anything that decides
   * access from `memberships` (e.g. the sub-account no-access redirect) must
   * gate on this, or it will act against an empty list on refresh.
   */
  membershipsLoaded: boolean;
}

export const AuthContext = createContext<AuthContextValue | undefined>(
  undefined,
);

/**
 * Waits before each retry of a load that failed because the connection
 * dropped. A network change (Wi-Fi → LTE, a VPN reconnecting, a host that
 * adds or removes an interface) aborts every in-flight request and flips
 * Firestore to "offline", so the first reads reject with `unavailable`.
 * Taking that as final left a signed-in user with no agency and no
 * memberships — "Sign in to view your agency", or a bounce to
 * /agency?error=no-access — until they reloaded. Firestore reconnects on its
 * own within seconds; these give it ~30s before the old outcome applies.
 */
const TRANSIENT_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];

function isTransientLoadError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "unavailable" || code === "auth/network-request-failed";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [adminUid, setAdminUid] = useState<string | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [status, setStatus] = useState<MemberStatus | null>(null);
  const [agencyId, setAgencyId] = useState<string | null>(null);
  const [agencyRole, setAgencyRole] = useState<AgencyRole | null>(null);
  const [memberships, setMemberships] = useState<UserSubAccountMembership[]>([]);
  const [membershipsLoaded, setMembershipsLoaded] = useState(false);

  useEffect(() => {
    if (!isFirebaseConfigured()) {
      setLoading(false);
      return;
    }

    let membershipUnsub: (() => void) | null = null;
    const cleanupMembership = () => {
      if (membershipUnsub) {
        membershipUnsub();
        membershipUnsub = null;
      }
    };
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // Bumped on every onUser pass. A pass that resumes after a newer one has
    // started (another user, a sign-out, a retry) is stale: it must not touch
    // shared state or the newer pass's membership listen.
    let generation = 0;

    const unsubscribe = onAuthStateChanged(
      getFirebaseAuth(),
      async function onUser(firebaseUser: User | null, attempt = 0) {
        clearTimeout(retryTimer);
        const gen = ++generation;
        setUser(firebaseUser);
        cleanupMembership();

        if (!firebaseUser) {
          setAdminUid(null);
          setRole(null);
          setStatus(null);
          setAgencyId(null);
          setAgencyRole(null);
          setMemberships([]);
          setMembershipsLoaded(true); // nothing to load — resolved
          setLoading(false);
          return;
        }

        // Re-gate: memberships for this user haven't arrived yet. Flips true
        // on the first membership snapshot (or on error) below.
        setMembershipsLoaded(false);

        let retrying = false;
        // This pass's own membership listen — torn down only by this pass,
        // never the shared handle another pass may have replaced.
        let ownMembershipUnsub: (() => void) | null = null;
        const dropOwnMembershipListen = () => {
          if (!ownMembershipUnsub) return;
          ownMembershipUnsub();
          if (membershipUnsub === ownMembershipUnsub) membershipUnsub = null;
          ownMembershipUnsub = null;
        };
        try {
          // Firestore rules need the `status: "active"` claim on the token
          // before any read fires, or they deny with "Missing or insufficient
          // permissions". A cached token that already carries it is used
          // straight away and refreshed in the background (the forced
          // refresh cost every page load ~335 ms); one without it — claims
          // set moments ago by signup / invite acceptance — is refreshed
          // FIRST, as before.
          const cachedClaims = await readActiveCachedClaims(firebaseUser);
          let claims =
            cachedClaims ?? (await loadIdTokenClaims(firebaseUser));
          if (gen !== generation) return;
          // Set once the user doc confirms an active user. Until then no
          // membership data is published and no claims are applied.
          let activeUser: UserDoc | null = null;
          const applyClaims = (u: UserDoc) => {
            setAgencyId(
              (claims.agencyId as string | undefined) ??
                u.primaryAgencyId ??
                null,
            );
            setAgencyRole(
              (claims.agencyRole as AgencyRole | null | undefined) ?? null,
            );
          };
          // getIdTokenResult(false) already refreshes a token that is near
          // expiry, so one issued within the last minute needs no second
          // refresh.
          const issuedAgoMs = Date.now() - Number(cachedClaims?.iat) * 1000;
          if (cachedClaims && !(Math.abs(issuedAgoMs) < 60_000)) {
            void firebaseUser.getIdTokenResult(true).then(
              ({ claims: fresh }) => {
                if (gen !== generation) return;
                claims = fresh;
                if (activeUser) applyClaims(activeUser);
              },
              // A failed refresh keeps the cached claims — never `{}`, which
              // would demote an owner (see loadIdTokenClaims).
              () => undefined,
            );
          }

          const db = getFirebaseDb();

          // Subscribe to the user's sub-account memberships so the switcher
          // updates live when an admin adds/removes them somewhere. Started
          // alongside the user-doc read rather than after it; snapshots are
          // held back until that read confirms the user is still active.
          let pendingMemberships: UserSubAccountMembership[] | null = null;
          const publishMemberships = (items: UserSubAccountMembership[]) => {
            if (gen !== generation) return;
            if (!activeUser) {
              pendingMemberships = items;
              return;
            }
            setMemberships(items);
            setMembershipsLoaded(true);
          };
          ownMembershipUnsub = onSnapshot(
            collection(db, `userMemberships/${firebaseUser.uid}/subAccounts`),
            (snap) => {
              const items: UserSubAccountMembership[] = snap.docs.map((d) => {
                const data = d.data() as Partial<UserSubAccountMembership>;
                return {
                  subAccountId: data.subAccountId ?? d.id,
                  agencyId: data.agencyId ?? "",
                  role: (data.role ?? "collaborator") as
                    | "admin"
                    | "collaborator",
                  name: data.name ?? "",
                  accountNumber: data.accountNumber,
                  addedAt:
                    data.addedAt instanceof Date
                      ? data.addedAt
                      : new Date(),
                };
              });
              // Stable, human-friendly order for every consumer (the header
              // switcher, legacy first-membership redirects): ascending
              // account number (#1000 first), docs without a number last,
              // ties broken by name.
              items.sort((a, b) => {
                const an = a.accountNumber ?? Number.MAX_SAFE_INTEGER;
                const bn = b.accountNumber ?? Number.MAX_SAFE_INTEGER;
                if (an !== bn) return an - bn;
                return a.name.localeCompare(b.name, undefined, {
                  sensitivity: "base",
                });
              });
              publishMemberships(items);
            },
            () => publishMemberships([]),
          );
          membershipUnsub = ownMembershipUnsub;

          const [cfgSnap, userSnap] = await Promise.all([
            getDoc(doc(db, "appConfig", "main")),
            getDoc(doc(db, "users", firebaseUser.uid)),
          ]);
          if (gen !== generation) return;

          const cfg = cfgSnap.exists()
            ? (cfgSnap.data() as AppConfig)
            : null;
          const userDoc = userSnap.exists()
            ? (userSnap.data() as UserDoc)
            : null;

          if (!userDoc || userDoc.status !== "active") {
            // Removed/orphan user — sign them out hard. Drop the membership
            // listen first: nothing it held back is ever published.
            dropOwnMembershipListen();
            // Not re-checked after this await: signing out starts a newer
            // (null) pass, and this path must still finish the removal.
            await signOutUser().catch(() => undefined);
            setAdminUid(null);
            setRole(null);
            setStatus("removed");
            setAgencyId(null);
            setAgencyRole(null);
            setMemberships([]);
            setMembershipsLoaded(true);
            setUser(null);
            if (typeof window !== "undefined") {
              window.location.href = "/login?reason=removed";
            }
            return;
          }

          setAdminUid(cfg?.adminUid ?? null);
          setRole(userDoc.role);
          setStatus(userDoc.status);
          activeUser = userDoc;
          applyClaims(userDoc);

          // Fire-and-forget: claim any pending sub-account invites for
          // this user's email. Handles the "invited to multiple
          // sub-accounts after my first signup" case — the signup route
          // 409s for existing users, so this is the only path that
          // attaches the 2nd, 3rd, … memberships. Idempotent. The
          // membership subscription above picks up any new docs the
          // route writes without us needing to do anything extra.
          void fetch("/api/auth/claim-pending-invites", {
            method: "POST",
            credentials: "include",
          }).catch((err) => {
            console.warn("[auth] claim-pending-invites failed", err);
          });

          if (pendingMemberships) publishMemberships(pendingMemberships);
        } catch (err) {
          // The user was never confirmed active: drop the listen, as before
          // when it was attached only after the user-doc read succeeded.
          dropOwnMembershipListen();
          if (gen !== generation) return;
          if (
            isTransientLoadError(err) &&
            attempt < TRANSIENT_RETRY_DELAYS_MS.length
          ) {
            // Still loading: nothing decides access until this settles.
            retrying = true;
            console.warn("[auth] load failed on a dropped connection; retrying", err);
            retryTimer = setTimeout(
              () => void onUser(firebaseUser, attempt + 1),
              TRANSIENT_RETRY_DELAYS_MS[attempt],
            );
          } else {
            console.error("Failed to load auth context", err);
            // Don't strand membership-gated UI when setup threw.
            setMembershipsLoaded(true);
          }
        } finally {
          if (!retrying && gen === generation) setLoading(false);
        }
      },
    );

    return () => {
      clearTimeout(retryTimer);
      cleanupMembership();
      unsubscribe();
    };
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        adminUid,
        role,
        status,
        agencyId,
        agencyRole,
        memberships,
        membershipsLoaded,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
