"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { readOwnerClaim } from "@/lib/firebase/id-token-claims";

export type OwnerClaimState = "loading" | "owner" | "not_owner" | "error";

/**
 * Whether the signed-in user is an agency owner, never answering "no" before
 * the claims are known.
 *
 * Straight after sign-in the auth context can already report `loading: false`
 * with no `agencyRole` — its first pass ran on the login page, with no user —
 * so a page that refuses on `agencyRole !== "owner"` flashes a refusal at a
 * real owner. This waits for a user, reads the claim itself, and reports a
 * failed read as "error" so the page can offer a retry instead of a refusal.
 */
export function useOwnerClaim(): { state: OwnerClaimState; retry: () => void } {
  const { user, agencyRole } = useAuth();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    uid: string;
    attempt: number;
    state: "owner" | "not_owner" | "error";
  } | null>(null);

  useEffect(() => {
    if (agencyRole === "owner" || !user) return;
    let cancelled = false;
    readOwnerClaim(user).then(
      (state) => {
        if (!cancelled) setResult({ uid: user.uid, attempt, state });
      },
      () => {
        if (!cancelled) setResult({ uid: user.uid, attempt, state: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [user, agencyRole, attempt]);

  const state: OwnerClaimState =
    agencyRole === "owner"
      ? "owner"
      : !user || result?.uid !== user.uid || result.attempt !== attempt
        ? "loading"
        : result.state;
  return { state, retry: () => setAttempt((n) => n + 1) };
}
