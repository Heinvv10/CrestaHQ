"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Circle, Loader2, MinusCircle } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import {
  buildLaunchpadChecklist,
  type LaunchpadCounts,
} from "@/lib/launchpad/checklist";

/**
 * Launchpad — a per-sub-account setup checklist (GHL "Launchpad" parity).
 * Every item reads real connection state; nothing here is a stored flag,
 * so it can't drift from what the feature it points at actually did.
 */
export default function LaunchpadPage() {
  const { subAccountId, subAccount, loading, isAdmin, saPath } = useSubAccount();
  const [counts, setCounts] = useState<LaunchpadCounts | null>(null);
  const [countsError, setCountsError] = useState(false);

  useEffect(() => {
    let live = true;
    setCounts(null);
    setCountsError(false);
    fetch(`/api/sub-accounts/${subAccountId}/launchpad`)
      .then(async (res) => {
        if (!res.ok) throw new Error("launchpad counts failed");
        return (await res.json()) as LaunchpadCounts;
      })
      .then((data) => {
        if (live) setCounts(data);
      })
      .catch(() => {
        if (live) setCountsError(true);
      });
    return () => {
      live = false;
    };
  }, [subAccountId]);

  if (loading || (!counts && !countsError)) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      </div>
    );
  }

  if (!subAccount || countsError || !counts) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <p className="text-muted-foreground text-sm">
          Couldn&apos;t load your setup checklist. Try refreshing the page.
        </p>
      </div>
    );
  }

  const items = buildLaunchpadChecklist(subAccount, counts, { isAdmin });
  // An item this viewer cannot complete (locked agency gate, not an admin)
  // is excluded from the denominator — it was never "1 of 7 to do" for them,
  // it's just not theirs to do.
  const available = items.filter((i) => i.available);
  const done = available.filter((i) => i.done).length;
  const total = available.length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">
          Here&apos;s your personalized setup list
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Finish these to get the most out of your workspace.
        </p>
      </div>

      <div className="mb-6 rounded-2xl border bg-card p-5">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="font-medium">
            {done} of {total} complete
          </span>
          <span className="text-muted-foreground">{percent}%</span>
        </div>
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
          data-testid="launchpad-progress"
          data-done={done}
          data-total={total}
        >
          <div
            className="h-full rounded-full bg-emerald-500 transition-all"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      <div className="space-y-3">
        {items.map((item) => (
          <div
            key={item.id}
            className="flex items-start gap-3 rounded-2xl border bg-card p-4"
            data-testid="launchpad-item"
            data-id={item.id}
            data-done={item.done}
            data-available={item.available}
          >
            {item.done ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
            ) : item.available ? (
              <Circle className="text-muted-foreground mt-0.5 h-5 w-5 shrink-0" />
            ) : (
              <MinusCircle className="text-muted-foreground/50 mt-0.5 h-5 w-5 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{item.title}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {item.done || item.available ? item.description : item.reason}
              </p>
            </div>
            {item.done ? (
              <span className="text-muted-foreground shrink-0 self-center text-xs font-medium">
                Done
              </span>
            ) : item.available ? (
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                render={<Link href={saPath(item.href)} />}
              >
                Set up
              </Button>
            ) : (
              <span className="text-muted-foreground/70 shrink-0 self-center text-xs font-medium">
                Not available
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
