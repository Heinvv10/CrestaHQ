"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { useEffectiveTerritoryFilter } from "@/hooks/use-effective-territory-filter";
import { subscribeToContacts } from "@/lib/firestore/contacts";
import type { Contact } from "@/types/contacts";

export interface SubAccountContacts {
  contacts: Contact[];
  /** True until the server's first answer for the current sub-account + territory filter. */
  loading: boolean;
  /** The listener's failure, if it failed. The next consumer mount retries. */
  error: Error | null;
}

interface ContactsContextValue extends SubAccountContacts {
  request: () => void;
}

const ContactsContext = createContext<ContactsContextValue | undefined>(
  undefined,
);

/**
 * One contacts listener shared by every page in a sub-account. A large
 * sub-account's list is megabytes; a listener per page re-downloaded it on
 * every navigation, because Firestore drops the docs when the last listener
 * on a query goes away. Lazy: nothing is fetched until a consumer asks, and
 * once asked it stays subscribed until the user, sub-account or territory
 * filter changes (or the provider unmounts on leaving the sub-account).
 */
export function ContactsProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const { subAccountId, agencyId } = useSubAccount();
  const { ready: filterReady, filter: territoryFilter } =
    useEffectiveTerritoryFilter();
  const uid = user?.uid;

  // Identifies the query the current viewer is allowed to run; null until
  // auth and the territory filter have resolved (an unfiltered listener
  // would trip permission-denied for a scoped collaborator).
  const key = useMemo(
    () =>
      !authLoading && uid && agencyId && filterReady
        ? JSON.stringify([uid, agencyId, subAccountId, territoryFilter])
        : null,
    [authLoading, uid, agencyId, subAccountId, filterReady, territoryFilter],
  );
  const [wantedKey, setWantedKey] = useState<string | null>(null);
  const [state, setState] = useState<{
    key: string;
    contacts: Contact[];
    error: Error | null;
  } | null>(null);

  // A new identity per key, so a consumer that stays mounted across a
  // sub-account or territory change asks again for the new query.
  const request = useCallback(() => {
    if (key) setWantedKey(key);
  }, [key]);

  useEffect(() => {
    if (!key || wantedKey !== key || !agencyId) return;
    return subscribeToContacts(
      { agencyId, subAccountId },
      { territoryFilter, waitForServer: true },
      (contacts) => setState({ key, contacts, error: null }),
      (error) => {
        console.warn(`[contacts-provider] contacts listener failed kind=${error.name}`);
        setState({ key, contacts: [], error });
        // The listener is dead after an error; let the next consumer retry.
        setWantedKey(null);
      },
    );
  }, [key, wantedKey, agencyId, subAccountId, territoryFilter]);

  const current = state && state.key === key ? state : null;
  const value = useMemo<ContactsContextValue>(
    () => ({
      contacts: current?.contacts ?? [],
      loading: !current,
      error: current?.error ?? null,
      request,
    }),
    [current, request],
  );

  return (
    <ContactsContext.Provider value={value}>
      {children}
    </ContactsContext.Provider>
  );
}

/**
 * The active sub-account's contacts, narrowed to the viewer's territories.
 * `enabled: false` (e.g. a closed dialog) reads without starting the download.
 */
export function useSubAccountContacts(enabled = true): SubAccountContacts {
  const ctx = useContext(ContactsContext);
  if (!ctx) {
    throw new Error("useSubAccountContacts must be used within a ContactsProvider");
  }
  const { request, contacts, loading, error } = ctx;
  useEffect(() => {
    if (enabled) request();
  }, [enabled, request]);
  return useMemo(() => ({ contacts, loading, error }), [contacts, loading, error]);
}
