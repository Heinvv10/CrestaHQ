"use client";

import { useEffect, useMemo, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { useAuth } from "@/hooks/use-auth";
import { useOptionalSubAccount } from "@/context/sub-account-context";
import { getFirebaseDb } from "@/lib/firebase/client";
import { GLOBAL_TERRITORY_ID } from "@/types";

/**
 * A scoped collaborator always sees the shared "Global" pool on top of
 * their assigned territories. Prepend Global (deduped, and first so it
 * survives the 30-item `in` slice) so the deal/contact query fetches
 * Global-tagged records too — matching the rules' `territoryId == "global"`
 * universal-visibility clause.
 */
function withGlobal(ids: string[]): string[] {
  return [
    GLOBAL_TERRITORY_ID,
    ...ids.filter((id) => id !== GLOBAL_TERRITORY_ID),
  ];
}

export interface EffectiveTerritoryFilter {
  /**
   * Has territory scoping fully resolved for the current user? `false`
   * while the membership doc is still loading. Callers can either
   * suspend their subscribe-call until this flips true, or accept the
   * brief "no filter" window during the load (which collapses into
   * "admins see everything" — safe for admins, possibly leaky for
   * collaborators in the half-second between mount and snapshot).
   */
  ready: boolean;
  /**
   * `null` = no filter (admin, agency owner, or scoping off).
   * `string[]` = pass to `subscribeToDeals` / `subscribeToContacts`.
   * An empty array means "this collaborator has no territories" — the
   * query helpers translate it into an empty snapshot.
   */
  filter: string[] | null;
}

/**
 * Returns the territory filter the current user should pass into
 * `subscribeToDeals` / `subscribeToContacts`. Reactive — re-fires when
 * the toggle flips, when the role changes, or when the admin updates
 * the member's assignedTerritoryIds.
 *
 * Off-by-default contract: when `subAccount.territoryScopingEnabled`
 * is anything other than `true`, this returns `{ ready: true, filter: null }`
 * immediately without subscribing to the member doc. Identical to the
 * pre-territory experience.
 */
export function useEffectiveTerritoryFilter(
  explicitSubAccountId?: string | null
): EffectiveTerritoryFilter {
  const { user, agencyId, agencyRole, memberships, membershipsLoaded } =
    useAuth();
  // Optional so callers above the SubAccountProvider (e.g. the Cmd+K
  // command palette mounted in the dashboard layout) can call this hook
  // safely. With no active sub-account, we collapse to "no filter" —
  // identical to the scoping-off path.
  const ctx = useOptionalSubAccount();
  const userUid = user?.uid;
  const explicit = explicitSubAccountId !== undefined;
  const [externalSub, setExternalSub] = useState<{
    id: string;
    data: { agencyId?: string; territoryScopingEnabled?: boolean } | null;
  } | null>(null);
  useEffect(() => {
    if (!explicitSubAccountId || !userUid) return;
    return onSnapshot(
      doc(getFirebaseDb(), "subAccounts", explicitSubAccountId),
      (snap) => {
        setExternalSub({
          id: explicitSubAccountId,
          data: snap.exists() ? snap.data() : null,
        });
      },
      () => setExternalSub({ id: explicitSubAccountId, data: null })
    );
  }, [explicitSubAccountId, userUid]);
  const externalReady =
    !!explicitSubAccountId &&
    externalSub?.id === explicitSubAccountId &&
    !!externalSub.data &&
    membershipsLoaded;
  const subAccount = explicit
    ? externalSub?.id === explicitSubAccountId
      ? externalSub.data
      : null
    : (ctx?.subAccount ?? null);
  const subAccountId = explicit
    ? explicitSubAccountId
    : (ctx?.subAccountId ?? null);
  const myRole = explicit
    ? agencyRole === "owner" && agencyId === subAccount?.agencyId
      ? "admin"
      : memberships.find((m) => m.subAccountId === subAccountId)?.role
    : (ctx?.myRole ?? null);

  const scopingOn = subAccount?.territoryScopingEnabled === true;
  const isPrivileged = myRole === "admin"; // agency owners resolve to admin

  const [assignment, setAssignment] = useState<{
    id: string;
    ids: string[];
  } | null>(null);
  const assignedIds = assignment?.id === subAccountId ? assignment.ids : null;

  useEffect(() => {
    // Skip the live subscribe when scoping is off or the user doesn't
    // need filtering. Both reset paths land at `null` so the consumer
    // gets a stable "no filter" value.
    if (!scopingOn || isPrivileged || !userUid || !subAccountId) {
      setAssignment(null);
      return;
    }
    const ref = doc(
      getFirebaseDb(),
      "subAccounts",
      subAccountId,
      "subAccountMembers",
      userUid
    );
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          setAssignment({ id: subAccountId, ids: [] });
          return;
        }
        const ids =
          (snap.data().assignedTerritoryIds as string[] | undefined) ?? [];
        setAssignment({ id: subAccountId, ids });
      },
      () => setAssignment({ id: subAccountId, ids: [] })
    );
    return () => unsub();
  }, [scopingOn, isPrivileged, userUid, subAccountId]);

  // Memoize so the returned array keeps a stable reference between renders
  // (only changing when assignedIds actually changes). Consumers list this
  // filter in useEffect deps to (re)issue Firestore listeners — a fresh
  // array every render would re-subscribe in an infinite loop.
  const filter = useMemo(
    () => (assignedIds === null ? null : withGlobal(assignedIds)),
    [assignedIds]
  );

  if (explicit && !externalReady) return { ready: false, filter: null };
  if (!scopingOn || isPrivileged) {
    return { ready: true, filter: null };
  }
  // Collaborator path — filter resolves when the member doc snapshot lands.
  if (assignedIds === null) {
    return { ready: false, filter: null };
  }
  return { ready: true, filter };
}
