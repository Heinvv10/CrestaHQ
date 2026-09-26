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
import { subscribeToConversations } from "@/lib/firestore/conversations";
import type { ConversationDoc } from "@/types/conversations";

export interface SubAccountConversations {
  conversations: ConversationDoc[];
  /** True until the server's first answer for the current sub-account + territory filter. */
  loading: boolean;
  /** The listener's failure, if it failed. The next consumer mount retries. */
  error: Error | null;
}

interface ConversationsContextValue extends SubAccountConversations {
  request: () => void;
}

const ConversationsContext = createContext<
  ConversationsContextValue | undefined
>(undefined);

/**
 * One conversations listener shared across visits to the inbox. A large
 * sub-account's list is megabytes; a listener per visit re-downloaded it on
 * every navigation, because Firestore drops the docs when the last listener
 * on a query goes away. Lazy: nothing is fetched until a consumer asks, and
 * once asked it stays subscribed until the user, sub-account or territory
 * filter changes (or the provider unmounts on leaving the sub-account).
 *
 * No provider-level wait hint: the inbox, its only consumer, shows its own.
 */
export function ConversationsProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const { subAccountId } = useSubAccount();
  const { ready: filterReady, filter: territoryFilter } =
    useEffectiveTerritoryFilter();
  const uid = user?.uid;

  // Identifies the query the current viewer is allowed to run; null until
  // auth and the territory filter have resolved (an unfiltered listener
  // would trip permission-denied for a scoped collaborator).
  const key = useMemo(
    () =>
      !authLoading && uid && subAccountId && filterReady
        ? JSON.stringify([uid, subAccountId, territoryFilter])
        : null,
    [authLoading, uid, subAccountId, filterReady, territoryFilter],
  );
  const [wantedKey, setWantedKey] = useState<string | null>(null);
  const [state, setState] = useState<{
    key: string;
    conversations: ConversationDoc[];
    error: Error | null;
  } | null>(null);

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
    if (!key || wantedKey !== key) return;
    const unsubscribe = subscribeToConversations(
      subAccountId,
      (conversations) => setState({ key, conversations, error: null }),
      (error) => {
        console.warn(`[conversations-provider] conversations listener failed kind=${error.name}`);
        setState({ key, conversations: [], error });
        // The listener is dead after an error; let the next consumer retry.
        setWantedKey(null);
      },
      territoryFilter,
      { waitForServer: true },
    );
    return () => {
      unsubscribe();
      // A list is only current while its listener runs: flipping the filter
      // away and back must wait for the new listener, not serve the old list.
      // A failure is kept to be shown until someone retries.
      setState((s) => (s?.error ? s : null));
    };
  }, [key, wantedKey, subAccountId, territoryFilter]);

  // A failure stops being current once a retry is under way.
  const current =
    state && state.key === key && !(state.error && wantedKey === key)
      ? state
      : null;
  const value = useMemo<ConversationsContextValue>(
    () => ({
      conversations: current?.conversations ?? [],
      loading: !current,
      error: current?.error ?? null,
      request,
    }),
    [current, request],
  );

  return (
    <ConversationsContext.Provider value={value}>
      {children}
    </ConversationsContext.Provider>
  );
}

/**
 * The active sub-account's conversations, narrowed to the viewer's
 * territories. Mounting it starts the shared download if nothing has yet.
 */
export function useSubAccountConversations(): SubAccountConversations {
  const ctx = useContext(ConversationsContext);
  if (!ctx) {
    throw new Error(
      "useSubAccountConversations must be used within a ConversationsProvider",
    );
  }
  const { request, conversations, loading, error } = ctx;
  const [requested, setRequested] = useState<(() => void) | null>(null);
  useEffect(() => {
    request();
    setRequested(() => request);
  }, [request]);
  // Mounting after a failure retries: report the retry's loading from the
  // first render, not the old error until the request lands.
  const retrying = !!error && requested !== request;
  return useMemo(
    () =>
      retrying
        ? { conversations: [], loading: true, error: null }
        : { conversations, loading, error },
    [retrying, conversations, loading, error],
  );
}
