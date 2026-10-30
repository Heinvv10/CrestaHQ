"use client";

import { useEffect, useState } from "react";
import { BookOpenCheck, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AiSuiteKnowledgeCard } from "@/types/ai-suite";

/**
 * Agency Settings → AI knowledge — LOCAL DEV ONLY (the availability probe
 * returns false on deployed instances, so this renders nothing there).
 *
 * "Review knowledge base" asks the model to diff the app's real feature
 * surface against the assistants' knowledge cards; the owner approves
 * changes card-by-card and Apply regenerates `knowledge-base.ts` in the
 * source tree — a normal git diff to review and commit.
 */

interface KbChange {
  op: "add" | "update" | "delete";
  id: string;
  reason: string;
  card?: AiSuiteKnowledgeCard;
}

const OP_STYLES: Record<KbChange["op"], string> = {
  add: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  update: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  delete: "bg-red-500/10 text-red-600 dark:text-red-400",
};

export function AgencyAiKbSection() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [changes, setChanges] = useState<KbChange[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agency/ai-kb")
      .then((r) => r.json())
      .then((d: { available?: boolean }) => {
        if (!cancelled) setAvailable(d.available === true);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!available) return null;

  async function review() {
    setReviewing(true);
    setChanges(null);
    try {
      const res = await fetch("/api/agency/ai-kb", { method: "POST" });
      const data = (await res.json().catch(() => null)) as {
        changes?: KbChange[];
        error?: string;
      } | null;
      if (!res.ok || !data?.changes) {
        throw new Error(data?.error || `Review failed (${res.status})`);
      }
      setChanges(data.changes);
      setSelected(new Set(data.changes.map((c) => c.id)));
      if (data.changes.length === 0) {
        toast.success("Knowledge base looks up to date — no changes proposed.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Review failed.");
    } finally {
      setReviewing(false);
    }
  }

  async function apply() {
    if (!changes) return;
    const approved = changes.filter((c) => selected.has(c.id));
    if (approved.length === 0) return;
    setApplying(true);
    try {
      const res = await fetch("/api/agency/ai-kb/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes: approved }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        added?: number;
        updated?: number;
        deleted?: number;
        error?: string;
      } | null;
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `Apply failed (${res.status})`);
      }
      toast.success(
        `Knowledge base updated (${data.added} added, ${data.updated} updated, ${data.deleted} removed). Review the file diff and commit it.`,
      );
      setChanges(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Apply failed.");
    } finally {
      setApplying(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section className="rounded-2xl border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <BookOpenCheck className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">AI knowledge</h2>
            <p className="mt-0.5 max-w-xl text-xs text-muted-foreground">
              Review the assistants&apos; knowledge base against the app&apos;s
              current features and apply proposed card updates.{" "}
              <span className="font-medium">Local development only</span> — the
              update rewrites{" "}
              <code className="rounded bg-muted px-1">knowledge-base.ts</code>,
              which you then commit like any code change.
            </p>
          </div>
        </div>
        <Button size="sm" onClick={review} disabled={reviewing || applying}>
          {reviewing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {reviewing ? "Reviewing… (can take a minute)" : "Review knowledge base"}
        </Button>
      </div>

      {changes && changes.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-xs text-muted-foreground">
            {changes.length} proposed change{changes.length === 1 ? "" : "s"} —
            untick anything you don&apos;t want, then apply.
          </p>
          {changes.map((c) => (
            <label
              key={c.id}
              className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/40"
            >
              <input
                type="checkbox"
                checked={selected.has(c.id)}
                onChange={() => toggle(c.id)}
                className="mt-1 h-3.5 w-3.5"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                      OP_STYLES[c.op],
                    )}
                  >
                    {c.op}
                  </span>
                  <span className="text-sm font-medium">
                    {c.card?.title ?? c.id}
                  </span>
                  <span className="text-xs text-muted-foreground">({c.id})</span>
                </div>
                {c.reason && (
                  <p className="mt-1 text-xs text-muted-foreground">{c.reason}</p>
                )}
                {c.card && (
                  <p className="mt-1 line-clamp-3 text-xs text-muted-foreground/80">
                    <span className="font-medium">{c.card.location}</span> —{" "}
                    {c.card.body}
                  </p>
                )}
              </div>
            </label>
          ))}
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              onClick={apply}
              disabled={applying || selected.size === 0}
            >
              {applying && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Apply {selected.size} change{selected.size === 1 ? "" : "s"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setChanges(null)}
              disabled={applying}
            >
              Discard
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
