"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Lock, Radar, Target } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { MysteryShopSettingsCard } from "@/components/prospecting/mystery-shop-settings-card";
import type { ProspectListQuery } from "@/types/prospecting";

/**
 * Prospecting — the sub-account's saved prospect lists (one per Get Leads
 * result set saved with "Save as list"). Lists come from
 * GET /api/sub-accounts/[id]/prospecting/lists; its 403 `gate_off` is the
 * locked state, so the page never decides the gate on its own.
 * Reports arrive in Prospecting PR 2 (docs/features/prospecting.md).
 */

interface ListRow {
  id: string;
  name: string;
  query: ProspectListQuery;
  count: number;
  createdAt: string | null;
}

type State =
  | { kind: "loading" }
  | { kind: "locked" }
  | { kind: "error"; message: string }
  | { kind: "ready"; lists: ListRow[] };

export default function ProspectingPage() {
  const { subAccountId } = useSubAccount();
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    if (!subAccountId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/sub-accounts/${subAccountId}/prospecting/lists`);
        const data = (await res.json().catch(() => ({}))) as {
          lists?: ListRow[];
          code?: string;
          error?: string;
        };
        if (cancelled) return;
        if (res.status === 403 && data.code === "gate_off") setState({ kind: "locked" });
        else if (!res.ok) setState({ kind: "error", message: data.error ?? "Couldn't load your lists." });
        else setState({ kind: "ready", lists: data.lists ?? [] });
      } catch {
        if (!cancelled) setState({ kind: "error", message: "Couldn't load your lists." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [subAccountId]);

  const getLeadsHref = `/sa/${subAccountId}/get-leads`;

  if (state.kind === "loading") {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <Header />
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading lists…
        </div>
      </div>
    );
  }

  if (state.kind === "locked") {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <Header />
        <div className="rounded-2xl border border-dashed bg-card p-10 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Lock className="h-6 w-6" />
          </span>
          <h2 className="mt-4 text-base font-semibold">Prospecting is locked by your agency</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Ask your agency administrator to enable Prospecting for this sub-account.
          </p>
        </div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <Header />
        <p className="text-sm text-red-600 dark:text-red-400">{state.message}</p>
      </div>
    );
  }

  if (state.lists.length === 0) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <Header />
        <div className="rounded-2xl border border-dashed bg-card p-10 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Target className="h-6 w-6" />
          </span>
          <h2 className="mt-4 text-base font-semibold">No prospect lists yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Run a search in Get Leads, then click “Save as list” on the results.
            Businesses you import from that search are linked to the list.
          </p>
          <Button render={<Link href={getLeadsHref} />} size="sm" className="mt-4">
            <Radar className="mr-1 h-3.5 w-3.5" />
            Open Get Leads
          </Button>
        </div>
        <MysteryShopSettingsCard />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Header />
        <Button render={<Link href={getLeadsHref} />} variant="outline" size="sm">
          <Radar className="mr-1 h-3.5 w-3.5" />
          New search
        </Button>
      </div>
      <ul className="divide-y rounded-2xl border bg-card">
        {state.lists.map((l) => (
          <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <p className="truncate font-medium">{l.name}</p>
              <p className="text-xs text-muted-foreground">
                {l.query.businessType.replace(/^custom:/, "")} ·{" "}
                {l.query.placeName || "your location"} · {l.query.radiusKm} km
              </p>
            </div>
            <div className="text-right text-xs text-muted-foreground">
              <p>
                <span className="font-semibold text-foreground">{l.count}</span> businesses
              </p>
              {l.createdAt && <p>Saved {new Date(l.createdAt).toLocaleDateString()}</p>}
            </div>
          </li>
        ))}
      </ul>
      <MysteryShopSettingsCard />
    </div>
  );
}

function Header() {
  return (
    <div className="min-w-0">
      <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
        <Target className="h-5 w-5" />
        Prospecting
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Your saved prospect lists. Each one is a Get Leads search you kept.
      </p>
    </div>
  );
}
