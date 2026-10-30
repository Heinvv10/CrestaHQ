"use client";

import { Loader2, Lock, Radar } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { WatchdogSection } from "@/components/ai-agents/monitors/watchdog-section";
import { StaleDealsSection } from "@/components/ai-agents/monitors/stale-deals-section";

/**
 * AI Agents → Monitors: background agents that watch the workspace and only
 * ever add a Task, a push and an activity row. Each monitor keeps its own
 * agency gate: the Inbox Follow-up Watchdog needs Labs (plus the AI Suite
 * gate, surfaced in its card), the Stale deals monitor needs
 * `agentsEnabledByAgency`. A locked monitor renders a Lock card instead.
 */
function LockedMonitor({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border bg-card p-6" data-testid={testId}>
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Lock className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{children}</p>
        </div>
      </div>
    </section>
  );
}

export default function MonitorsPage() {
  const { subAccount, loading } = useSubAccount();

  // Until the workspace doc arrives every gate reads as off; showing the
  // locks then would flash them on every load.
  if (loading) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  const labsOn = subAccount?.labsEnabledByAgency === true;
  const agentsOn = subAccount?.agentsEnabledByAgency === true;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <header className="flex items-start gap-4">
        <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500/15 via-teal-500/15 to-cyan-500/15 text-emerald-600 dark:text-emerald-400">
          <Radar className="h-6 w-6" />
        </span>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            Monitors
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
              Beta
            </span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Agents that watch the workspace every hour and raise a hand when
            something is slipping. They only ever add a task, a push and a note
            on the contact — never a message to a customer, never a change to a
            record.
          </p>
        </div>
      </header>

      <section className="space-y-4">
        {labsOn ? (
          <WatchdogSection />
        ) : (
          <LockedMonitor title="Inbox Follow-up Watchdog" testId="monitor-watchdog-locked">
            The inbox watchdog is a Labs feature and Labs is locked for this
            sub-account. Ask your agency owner to enable Labs from the
            sub-account&apos;s Manage panel.
          </LockedMonitor>
        )}
        {agentsOn ? (
          <StaleDealsSection />
        ) : (
          <LockedMonitor title="Stale deals" testId="monitor-stale-deals-locked">
            The stale deals monitor is locked for this sub-account. It spends
            your agency&apos;s AI credits, so your agency owner switches Agent
            monitors on from the sub-account&apos;s Manage panel.
          </LockedMonitor>
        )}
      </section>
    </div>
  );
}
