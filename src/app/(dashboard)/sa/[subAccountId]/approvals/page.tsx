"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ApprovalCard } from "@/components/approvals/approval-card";
import { useSubAccount } from "@/context/sub-account-context";
import type { ApprovalRow } from "@/lib/approvals/messages";

/**
 * Approvals — actions an API agent asked for that a person must approve
 * (AGENT_API_V1_PLAN.md, PR6). Read ONLY through the list route: it applies
 * the territory rule server-side, which a client SDK list query cannot
 * (rules are not filters), and it keeps `pinned` off the browser. The
 * actionable rows come from `?status=open` — the same set the sidebar badge
 * counts — so an old pending row can never be counted yet not shown; terminal
 * rows come from a separate `?status=recent`. With the Agent API gate off,
 * only unsettled rows load: their mark actions must stay reachable.
 */

export default function ApprovalsPage() {
  const { subAccountId, subAccount } = useSubAccount();
  const gateOn = subAccount?.agentApiEnabledByAgency === true;
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [recent, setRecent] = useState<ApprovalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoadError(null);
    const load = async (status: string) => {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/agent-proposals?status=${status}`);
      const data = (await res.json().catch(() => ({}))) as { proposals?: ApprovalRow[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't load approvals.");
      return data.proposals ?? [];
    };
    try {
      if (gateOn) {
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
  }, [subAccountId, gateOn]);

  useEffect(() => {
    if (!subAccount) return;
    void reload();
  }, [subAccount, reload]);

  const replace = (next: ApprovalRow) => setRows((rs) => rs.map((r) => (r.id === next.id ? next : r)));
  const unsettled = rows.filter((r) => r.status === "unsettled");
  const pending = rows.filter((r) => r.status === "pending");
  const card = (r: ApprovalRow) => (
    <ApprovalCard key={r.id} subAccountId={subAccountId} row={r} onReplace={replace} onChanged={reload} />
  );

  if (!subAccount) {
    return (
      <Shell>
        <Centered>
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
        </Centered>
      </Shell>
    );
  }

  if (loading) {
    return (
      <Shell>
        <Centered>
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
        </Centered>
      </Shell>
    );
  }

  if (!gateOn && !loadError && unsettled.length === 0) {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed py-16 text-center">
          <Lock className="text-muted-foreground h-6 w-6" />
          <p className="text-sm font-medium">Approvals are locked</p>
          <p className="text-muted-foreground max-w-md text-xs">
            Agent API access isn&apos;t enabled for this workspace. Ask your agency to turn it on.
          </p>
        </div>
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

  if (!gateOn) {
    // Agent API off: nothing new can be approved, but a person must still be
    // able to settle what is outstanding.
    return (
      <Shell>
        <p className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm" data-testid="approvals-paused">
          New approvals are paused because Agent API access is off for this workspace. Settle these outstanding ones.
        </p>
        <Section title="Needs checking" hint="We don't know if these went out. Check, then say which.">
          {unsettled.map(card)}
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
            When an API agent asks to send a message, delete a record or start a workflow, it waits here for you.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      {unsettled.length > 0 && (
        <Section title="Needs checking" hint="We don't know if these went out. Check, then say which.">
          {unsettled.map(card)}
        </Section>
      )}
      <Section title="Waiting for approval">
        {pending.length > 0 ? pending.map(card) : (
          <p className="text-muted-foreground text-sm">Nothing is waiting.</p>
        )}
      </Section>
      {recent.length > 0 && <Section title="Recent">{recent.map(card)}</Section>}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Actions an API agent asked for. Nothing here happens until a person approves it.
        </p>
      </div>
      {children}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-center rounded-2xl border py-16">{children}</div>;
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
