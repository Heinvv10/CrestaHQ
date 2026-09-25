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
import { useLoadingHint } from "@/hooks/use-loading-hint";
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
  /** Counts a mounted consumer that relies on the provider's wait hint. */
  watch: () => () => void;
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
  const [waiters, setWaiters] = useState(0);

  // Signed out or auth reloading: forget the request and the list, so a
  // returning user neither re-subscribes without a consumer nor sees the
  // old list while the new listener waits for the server.
  useEffect(() => {
    if (key) return;
    setWantedKey(null);
    setState(null);
  }, [key]);

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

  const watch = useCallback(() => {
    setWaiters((n) => n + 1);
    return () => setWaiters((n) => n - 1);
  }, []);

  const current = state && state.key === key ? state : null;
  const value = useMemo<ContactsContextValue>(
    () => ({
      contacts: current?.contacts ?? [],
      loading: !current,
      error: current?.error ?? null,
      request,
      watch,
    }),
    [current, request, watch],
  );

  // waitForServer never answers from the cache, so offline (or on a stalled
  // connection) a page would sit on its skeleton with no explanation.
  const waiting = !!key && !current && waiters > 0;
  return (
    <ContactsContext.Provider value={value}>
      {waiting && <ContactsWaitHint key={key} />}
      {children}
    </ContactsContext.Provider>
  );
}

/** Keyed per load by the provider, so the slow timer measures the current one. */
function ContactsWaitHint() {
  const hint = useLoadingHint();
  if (!hint) return null;
  return (
    <p
      role="status"
      className="mx-auto mb-4 w-full max-w-5xl rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
    >
      {hint === "offline"
        ? "You're offline. Contacts will load when your connection is back."
        : "Still loading contacts — this is taking longer than usual. If it doesn't finish, reload the page."}
    </p>
  );
}

/**
 * The active sub-account's contacts, narrowed to the viewer's territories.
 * `enabled: false` (e.g. a closed dialog) reads without starting the download.
 * `ownsLoadingHint`: the caller shows its own slow/offline hint, so the
 * provider's banner stays out of the way.
 */
export function useSubAccountContacts(
  enabled = true,
  { ownsLoadingHint = false }: { ownsLoadingHint?: boolean } = {},
): SubAccountContacts {
  const ctx = useContext(ContactsContext);
  if (!ctx) {
    throw new Error("useSubAccountContacts must be used within a ContactsProvider");
  }
  const { request, watch, contacts, loading, error } = ctx;
  useEffect(() => {
    if (enabled) request();
  }, [enabled, request]);
  useEffect(() => {
    if (enabled && !ownsLoadingHint) return watch();
  }, [enabled, ownsLoadingHint, watch]);
  return useMemo(() => ({ contacts, loading, error }), [contacts, loading, error]);
}
