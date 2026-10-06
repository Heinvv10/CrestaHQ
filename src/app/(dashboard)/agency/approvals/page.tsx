"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AgencyApprovalGroups } from "@/components/approvals/agency-approval-groups";
import { useAuth } from "@/hooks/use-auth";
import { useAgency } from "@/hooks/use-agency";
import type { AgencyApprovalRow } from "@/lib/approvals/agency-batch";

/**
 * Agency approvals (AGENCY_AGENT_API_PLAN.md D4, A5): what the agency's own
 * API keys asked for, agency-level (a feature gate, later billing) or
 * inside one sub-account, grouped by that sub-account. Read through the
 * agency list route (owner only, `pinned` stays on the server): the
 * actionable `?status=open` set the sidebar badge counts, terminal rows
 * from `?status=recent`. With the agency's Agent API switch off only
 * unsettled rows load: nothing new can be approved, but they must be settled.
 */

export default function AgencyApprovalsPage() {
  const { agencyRole, loading: authLoading } = useAuth();
  const agency = useAgency();
  const switchOn = agency.agentApiEnabled;
  const isOwner = agencyRole === "owner";
  const [rows, setRows] = useState<AgencyApprovalRow[]>([]);
  const [recent, setRecent] = useState<AgencyApprovalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoadError(null);
    const load = async (status: string) => {
      const res = await fetch(`/api/agency/agent-proposals?status=${status}`);
      const data = (await res.json().catch(() => ({}))) as { proposals?: AgencyApprovalRow[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't load approvals.");
      return data.proposals ?? [];
    };
    try {
      if (switchOn) {
        const [open, done] = await Promise.all([load("open"), load("recent")]);
        setRows(open);
        setRecent(done);
      } else {
        setRows(await load("unsettled"));
        setRecent([]);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't load approvals.");
    } finally {
      setLoading(false);
    }
  }, [switchOn]);

  useEffect(() => {
    if (authLoading || !isOwner) return;
    void reload();
  }, [authLoading, isOwner, reload]);

  const replace = (next: AgencyApprovalRow) => setRows((rs) => rs.map((r) => (r.id === next.id ? next : r)));
  const unsettled = rows.filter((r) => r.status === "unsettled");
  const pending = rows.filter((r) => r.status === "pending");
  const groups = (list: AgencyApprovalRow[]) => (
    <AgencyApprovalGroups rows={list} onReplace={replace} onChanged={reload} />
  );

  if (authLoading || (isOwner && loading)) {
    return (
      <Shell>
        <div className="flex items-center justify-center rounded-2xl border py-16">
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
        </div>
      </Shell>
    );
  }

  if (!isOwner) {
    return (
      <Shell>
        <p className="text-muted-foreground rounded-2xl border border-dashed p-10 text-center text-sm">
          Agency approvals are available to the agency owner.
        </p>
      </Shell>
    );
  }

  if (loadError) {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed py-16 text-center">
          <p className="text-sm font-medium">{loadError}</p>
          <Button size="sm" variant="outline" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      </Shell>
    );
  }

  if (!switchOn && unsettled.length === 0) {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed py-16 text-center">
          <Lock className="text-muted-foreground h-6 w-6" />
          <p className="text-sm font-medium">Approvals are locked</p>
          <p className="text-muted-foreground max-w-md text-xs">
            The Agent API is switched off for this agency. Switch it on in Agency settings to approve what your agency keys ask for.
          </p>
        </div>
      </Shell>
    );
  }

  if (!switchOn) {
    return (
      <Shell>
        <p className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm" data-testid="approvals-paused">
          New approvals are paused because the Agent API is switched off for this agency. Settle these outstanding ones.
        </p>
        <Section title="Needs checking" hint="We don't know if these went out. Check, then say which.">
          {groups(unsettled)}
        </Section>
      </Shell>
    );
  }

  if (rows.length === 0 && recent.length === 0) {
    return (
      <Shell>
        <div className="bg-card rounded-2xl border p-12 text-center">
          <CheckCircle2 className="text-muted-foreground mx-auto h-10 w-10" />
          <h2 className="mt-4 text-base font-semibold">Nothing to approve</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            When an agency API key asks to switch a feature, activate a workflow or send a message, it waits here for you.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      {unsettled.length > 0 && (
        <Section title="Needs checking" hint="We don't know if these went out. Check, then say which.">
          {groups(unsettled)}
        </Section>
      )}
      <Section title="Waiting for approval">
        {pending.length > 0 ? groups(pending) : <p className="text-muted-foreground text-sm">Nothing is waiting.</p>}
      </Section>
      {recent.length > 0 && <Section title="Recent">{groups(recent)}</Section>}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6" data-testid="agency-approvals">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          What your agency&apos;s API keys asked for, by sub-account. Nothing here happens until you approve it.
        </p>
      </div>
      {children}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        {hint && <p className="text-muted-foreground text-sm">{hint}</p>}
      </div>
      {children}
    </section>
  );
}
