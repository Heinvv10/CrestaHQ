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
import { useRouter } from "next/navigation";
import { doc, onSnapshot } from "firebase/firestore";
import { toast } from "sonner";
import { getFirebaseDb } from "@/lib/firebase/client";
import { fetchPipelines } from "@/lib/pipelines/client";
import { syntheticDefaultPipeline } from "@/lib/pipelines/stages";
import { useAuth } from "@/hooks/use-auth";
import type { SubAccountDoc, SubAccountRole } from "@/types";
import type { PipelineDoc } from "@/types/deals";

export interface SubAccountContextValue {
  subAccountId: string;
  subAccount: SubAccountDoc | null;
  loading: boolean;
  /**
   * The caller's effective role inside this sub-account. Agency owners are
   * resolved to "admin" automatically.
   */
  myRole: SubAccountRole | null;
  isAdmin: boolean;
  agencyId: string | null;
  /**
   * The sub-account's deal pipelines, default first, read once per mount
   * through the Admin-SDK route (the subcollection is server-only at the
   * rules level). Until that read lands this holds a synthesized default
   * built from the legacy stage overrides, so consumers always have one to
   * render. Call `refreshPipelines()` after a pipeline write.
   */
  pipelines: PipelineDoc[];
  refreshPipelines: () => Promise<void>;
  /**
   * Prefix a relative dashboard path with the active sub-account segment,
   * e.g. saPath("/contacts") -> "/sa/abc123/contacts". Use this for every
   * in-app navigation so links stay scoped to the current sub-account.
   */
  saPath: (path: string) => string;
}

const SubAccountContext = createContext<SubAccountContextValue | undefined>(
  undefined,
);

export function SubAccountProvider({
  subAccountId,
  children,
}: {
  subAccountId: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const {
    user,
    agencyId: claimAgencyId,
    agencyRole,
    memberships,
    membershipsLoaded,
    loading: authLoading,
  } = useAuth();
  const [subAccount, setSubAccount] = useState<SubAccountDoc | null>(null);
  const [subLoading, setSubLoading] = useState(true);
  const [pipelineDocs, setPipelineDocs] = useState<PipelineDoc[]>([]);

  const refreshPipelines = useCallback(async () => {
    if (!subAccountId) return;
    try {
      setPipelineDocs(await fetchPipelines(subAccountId));
    } catch (err) {
      // Keep the last-known list (or the synthesized default on a cold
      // start) and say so — silently showing only the default would make
      // every other pipeline's deals vanish from the board.
      console.error("[sub-account] pipelines load failed", err);
      toast.error("Couldn't load pipelines — showing what was last loaded.");
    }
  }, [subAccountId]);

  useEffect(() => {
    if (!user || !subAccountId) {
      setPipelineDocs([]);
      return;
    }
    void refreshPipelines();
  }, [user, subAccountId, refreshPipelines]);

  const pipelines = useMemo(
    () =>
      pipelineDocs.some((p) => p.isDefault)
        ? pipelineDocs
        : [
            syntheticDefaultPipeline(subAccountId, subAccount?.pipelineStages),
            ...pipelineDocs,
          ],
    [pipelineDocs, subAccountId, subAccount?.pipelineStages],
  );

  useEffect(() => {
    if (!user || !subAccountId) {
      setSubAccount(null);
      setSubLoading(false);
      return;
    }
    // The branch above ran while auth was still settling; loading stays
    // honest until THIS listener's first snapshot, or a gate reads as off.
    setSubLoading(true);
    const unsub = onSnapshot(
      doc(getFirebaseDb(), "subAccounts", subAccountId),
      (snap) => {
        if (!snap.exists()) {
          setSubAccount(null);
          setSubLoading(false);
          return;
        }
        setSubAccount(snap.data() as SubAccountDoc);
        setSubLoading(false);
      },
      () => {
        setSubAccount(null);
        setSubLoading(false);
      },
    );
    return () => unsub();
  }, [user, subAccountId]);

  // Compute role + access. Agency owners always pass.
  const ownerForThisAgency =
    agencyRole === "owner" &&
    !!subAccount &&
    !!claimAgencyId &&
    subAccount.agencyId === claimAgencyId;
  const membership = memberships.find((m) => m.subAccountId === subAccountId);
  const myRole: SubAccountRole | null = ownerForThisAgency
    ? "admin"
    : (membership?.role ?? null);
  const isAdmin = ownerForThisAgency || myRole === "admin";

  // No-access redirect: only fire after auth + sub-account snapshots resolve,
  // and only if neither the agency-owner shortcut nor a membership covers us.
  useEffect(() => {
    if (authLoading || subLoading) return;
    // Wait for memberships to actually arrive — `authLoading` flips false
    // before the membership snapshot lands, so without this a refresh would
    // bounce a valid collaborator to no-access against an empty list.
    if (!membershipsLoaded) return;
    if (!user) return;
    if (!subAccount) return; // sub-account doesn't exist; let the page handle it
    if (ownerForThisAgency) return;
    if (membership) return;
    router.replace("/agency?error=no-access");
  }, [
    authLoading,
    subLoading,
    membershipsLoaded,
    user,
    subAccount,
    ownerForThisAgency,
    membership,
    router,
  ]);

  const value: SubAccountContextValue = {
    subAccountId,
    subAccount,
    // Include membershipsLoaded so consumers don't read a stale myRole /
    // isAdmin (both derived from `membership`) before memberships arrive.
    loading: authLoading || subLoading || !membershipsLoaded,
    myRole,
    isAdmin,
    agencyId: subAccount?.agencyId ?? claimAgencyId,
    pipelines,
    refreshPipelines,
    saPath: (path: string) => {
      if (!path.startsWith("/")) return path;
      return `/sa/${subAccountId}${path}`;
    },
  };

  return (
    <SubAccountContext.Provider value={value}>
      {children}
    </SubAccountContext.Provider>
  );
}

export function useSubAccount(): SubAccountContextValue {
  const ctx = useContext(SubAccountContext);
  if (!ctx) {
    throw new Error("useSubAccount must be used within a SubAccountProvider");
  }
  return ctx;
}

/**
 * Like useSubAccount() but returns null when no provider is mounted.
 * Useful for components shared between agency-level and sub-account-level
 * pages (e.g. the global header).
 */
export function useOptionalSubAccount(): SubAccountContextValue | null {
  return useContext(SubAccountContext) ?? null;
}
