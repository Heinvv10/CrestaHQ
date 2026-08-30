"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Route } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { subscribeToFunnels } from "@/lib/firestore/funnels";
import type { Funnel } from "@/types/funnels";

/**
 * Labs card for the Quick Funnels experiment (the quick funnel builder).
 *
 * Deliberately thin — the Labs page is "a thin shell so adding/removing an
 * experiment is one card", and withdrawing this feature should be deleting
 * one import plus the `labs/funnels` route folder.
 *
 * The builder lives on its own page rather than inline: a sectioned form with
 * three steps doesn't fit a card, and keeping it separate means the Labs page
 * stays scannable as experiments come and go.
 */
export function FunnelsSection() {
  const { user, loading: authLoading } = useAuth();
  const { subAccountId, subAccount, saPath } = useSubAccount();
  const [funnels, setFunnels] = useState<Funnel[]>([]);

  const paymentsOn = subAccount?.paymentsEnabledByAgency === true;

  useEffect(() => {
    if (authLoading || !user || !subAccountId) return;
    const unsub = subscribeToFunnels(subAccountId, setFunnels, () =>
      setFunnels([]),
    );
    return () => unsub();
  }, [authLoading, user, subAccountId]);

  const published = funnels.filter((f) => f.status === "published").length;

  return (
    <section className="rounded-2xl border bg-card p-6">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
          <Route className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">Quick Funnels</h2>
            <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
              Experimental
            </span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Fill in a form, pick a template, and get a hosted three-step funnel —
            pitch page, checkout, thank-you — on a link you can send traffic to.
            No page building.
          </p>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 p-4">
        <div className="text-sm">
          {funnels.length === 0 ? (
            <span className="text-muted-foreground">No funnels yet.</span>
          ) : (
            <span>
              <span className="font-medium">{funnels.length}</span> funnel
              {funnels.length === 1 ? "" : "s"} ·{" "}
              <span className="font-medium">{published}</span> published
            </span>
          )}
          {!paymentsOn && (
            <p className="mt-1 text-xs text-muted-foreground">
              Payments is off, so funnels can only link out (a booking page, a
              form). Enable Payments to sell through one.
            </p>
          )}
        </div>
        <Link href={saPath("/labs/funnels")}>
          <Button variant="outline" size="sm">
            {funnels.length === 0 ? "Build one" : "Manage funnels"}
          </Button>
        </Link>
      </div>
    </section>
  );
}
