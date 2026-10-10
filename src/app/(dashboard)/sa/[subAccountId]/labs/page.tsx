"use client";

import { FlaskConical, Loader2, Lock } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { WatchdogSection } from "@/components/labs/watchdog-section";
import { FunnelsSection } from "@/components/labs/funnels-section";

/**
 * Labs — the gated container for PRE-RELEASE / experimental features.
 *
 * Agency-gated via `labsEnabledByAgency` (off by default; the sidebar entry
 * follows the standard gate + hidden-when-disabled treatment). Each
 * experiment listed here is explicitly pre-release: it may change, move, or
 * be withdrawn, and it keeps its own runtime safeguards on top of the Labs
 * gate (e.g. the Inbox Watchdog also requires the AI Suite gate to spend
 * agency AI credits — see CUSTOM_AGENTS_V1_PLAN.md).
 *
 * Experiments graduate OUT of Labs into the main nav when proven; this page
 * is deliberately a thin shell so adding/removing an experiment is one card.
 */
export default function LabsPage() {
  const { subAccount, loading } = useSubAccount();
  const labsEnabled = subAccount?.labsEnabledByAgency === true;

  // Until the workspace doc arrives the gate reads as off; showing "locked"
  // then flashes it on every load of a workspace that has Labs on.
  if (loading) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (!labsEnabled) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <section className="rounded-2xl border bg-card p-6">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Lock className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-base font-semibold">Labs</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Labs is locked for this sub-account. Your agency controls
                access to pre-release features — ask your agency owner to
                enable Labs from the sub-account&apos;s Manage panel.
              </p>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <header className="flex items-start gap-4">
        <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-lime-500/15 via-emerald-500/15 to-teal-500/15 text-lime-600 dark:text-lime-400">
          <FlaskConical className="h-6 w-6" />
        </span>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            Labs
            <span className="rounded-full bg-lime-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-lime-600 dark:text-lime-400">
              Pre-release
            </span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Early access to features still in development. Everything here is
            experimental — it may change, move, or be withdrawn as it matures.
            Proven features graduate into the main menu.
          </p>
        </div>
      </header>

      <section className="space-y-4">
        {/* ── Experiment: Inbox Follow-up Watchdog (LIVE) ────────────────── */}
        <WatchdogSection />

        {/* ── Experiment: Quick Funnels (LIVE) ───────────────────────────── */}
        <FunnelsSection />

        <p className="text-xs text-muted-foreground">
          Have an idea for an experiment? Tell your agency — Labs is where new
          functionality lands first.
        </p>
      </section>
    </div>
  );
}
