"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  AgencyTemplateSummary,
  TemplatePushResult,
} from "@/types/templates";

export interface SubOption {
  id: string;
  name: string;
  accountNumber?: number;
}

export function subLabel(s: SubOption): string {
  return s.accountNumber ? `#${s.accountNumber} ${s.name}` : s.name;
}

function describeCreated(c: TemplatePushResult["created"]): string {
  const parts: string[] = [];
  if (c.workflows) parts.push(`${c.workflows} workflow${c.workflows > 1 ? "s" : ""} (draft)`);
  if (c.forms) parts.push(`${c.forms} form${c.forms > 1 ? "s" : ""}`);
  if (c.messageTemplates) parts.push(`${c.messageTemplates} email template${c.messageTemplates > 1 ? "s" : ""}`);
  return parts.join(", ") || "nothing";
}

/** Total items a re-push found already present (and left untouched). */
function totalSkipped(s: TemplatePushResult["skipped"]): number {
  return s.workflows + s.forms + s.messageTemplates;
}

/**
 * Pick target sub-accounts, push, then show the per-target outcome in place
 * so a partial failure is visible rather than buried in a toast.
 */
export function PushTemplateDialog({
  template,
  subs,
  open,
  onOpenChange,
}: {
  template: AgencyTemplateSummary | null;
  subs: SubOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pushing, setPushing] = useState(false);
  const [results, setResults] = useState<TemplatePushResult[] | null>(null);

  function reset(next: boolean) {
    if (!next) {
      setSelected(new Set());
      setResults(null);
    }
    onOpenChange(next);
  }

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function handlePush() {
    if (!template || pushing || selected.size === 0) return;
    setPushing(true);
    try {
      const res = await fetch(`/api/agency/templates/${template.id}/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subAccountIds: [...selected] }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        results?: TemplatePushResult[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Push failed.");
      setResults(data.results ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Push failed.");
    } finally {
      setPushing(false);
    }
  }

  const nameOf = (id: string) => {
    const s = subs.find((x) => x.id === id);
    return s ? subLabel(s) : id;
  };

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Push &ldquo;{template?.name}&rdquo;</DialogTitle>
          <DialogDescription>
            Creates a copy in each selected sub-account. Nothing there is
            ever overwritten — workflows arrive as drafts, and re-pushing
            the same template skips anything already present instead of
            touching it.
            {template?.includesTriggerForm &&
              " Its trigger form is pushed alongside and re-linked."}
          </DialogDescription>
        </DialogHeader>

        {results ? (
          <ul className="max-h-72 space-y-1 overflow-y-auto text-sm">
            {results.map((r) => (
              <li
                key={r.subAccountId}
                data-testid="template-push-result"
                data-sub-account-id={r.subAccountId}
                data-ok={r.ok ? "true" : "false"}
                className="flex items-start justify-between gap-3 rounded-md border px-3 py-2"
              >
                <span className="truncate">{nameOf(r.subAccountId)}</span>
                <span
                  className={
                    r.ok
                      ? "shrink-0 text-xs text-emerald-600 dark:text-emerald-400"
                      : "shrink-0 text-xs text-destructive"
                  }
                >
                  {r.ok
                    ? `Created ${describeCreated(r.created)}` +
                      (totalSkipped(r.skipped) > 0
                        ? ` · ${totalSkipped(r.skipped)} already present, skipped`
                        : "")
                    : r.error}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {subs.map((s) => (
              <li key={s.id}>
                <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60">
                  <Checkbox
                    data-testid="template-push-target"
                    data-sub-account-id={s.id}
                    checked={selected.has(s.id)}
                    onCheckedChange={(on) => toggle(s.id, on === true)}
                    disabled={pushing}
                  />
                  <span className="truncate">{subLabel(s)}</span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <DialogFooter>
          {results ? (
            <Button onClick={() => reset(false)}>Done</Button>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={() => reset(false)}
                disabled={pushing}
              >
                Cancel
              </Button>
              <Button
                onClick={handlePush}
                disabled={pushing || selected.size === 0}
                data-testid="template-push-submit"
              >
                {pushing && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                Push to {selected.size || ""} sub-account
                {selected.size === 1 ? "" : "s"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
