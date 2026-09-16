"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { useAuth } from "@/hooks/use-auth";
import { getFirebaseDb } from "@/lib/firebase/client";
import { TemplateLibrary } from "@/components/templates/template-library";
import type { SubAccountDoc } from "@/types";

export default function AgencyTemplatesPage() {
  const { agencyId, agencyRole, loading: authLoading } = useAuth();
  const [subs, setSubs] = useState<SubAccountDoc[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!agencyId) {
      setSubs([]);
      setLoading(false);
      return;
    }
    // Same agency-only query as /agency/sub-accounts; sorted client-side so
    // no composite index is needed.
    const q = query(
      collection(getFirebaseDb(), "subAccounts"),
      where("agencyId", "==", agencyId),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs.map((d) => d.data() as SubAccountDoc);
        list.sort(
          (a, b) =>
            (a.accountNumber ?? Number.MAX_SAFE_INTEGER) -
            (b.accountNumber ?? Number.MAX_SAFE_INTEGER),
        );
        setSubs(list);
        setLoading(false);
      },
      (err) => {
        console.error("[agency/templates] listen failed", err);
        setLoading(false);
      },
    );
    return () => unsub();
  }, [agencyId]);

  if (authLoading || loading) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="h-32 animate-pulse rounded-2xl bg-muted/50" />
      </div>
    );
  }

  if (agencyRole !== "owner") {
    return (
      <div className="mx-auto max-w-5xl">
        <p className="rounded-2xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          The template library is available to the agency owner.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Template library</h1>
        <p className="text-sm text-muted-foreground">
          Workflows, email templates and forms saved from your sub-accounts.
          Push any of them into one or more sub-accounts — copies are created,
          nothing is overwritten, and workflows arrive as drafts.
        </p>
      </div>
      <TemplateLibrary
        subs={subs.map((s) => ({
          id: s.id,
          name: s.name,
          accountNumber: s.accountNumber,
        }))}
      />
    </div>
  );
}
