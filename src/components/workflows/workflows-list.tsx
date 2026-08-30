"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  CalendarCheck,
  ChevronDown,
  GitBranch,
  Loader2,
  Plus,
  Reply,
  Sprout,
  Trash2,
  Workflow,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WorkflowStatusBadge } from "./workflow-status-badge";
import { TRIGGER_LABELS } from "@/lib/workflows/catalog";
import type { WorkflowStatus, WorkflowTriggerType } from "@/types/workflows";

type WorkflowTemplate =
  | "speed-to-lead"
  | "appointment-confirmation"
  | "lead-nurture"
  | "stage-change-followup"
  | "no-reply-followup";

const TEMPLATES: {
  id: WorkflowTemplate;
  label: string;
  hint: string;
  icon: typeof Zap;
}[] = [
  {
    id: "speed-to-lead",
    label: "Speed-to-Lead",
    hint: "Form submit → instant SMS + email + notify",
    icon: Zap,
  },
  {
    id: "appointment-confirmation",
    label: "Appointment Confirmation",
    hint: "New booking → confirm to contact + prep task",
    icon: CalendarCheck,
  },
  {
    id: "lead-nurture",
    label: "Lead Nurture",
    hint: "Multi-day email/SMS drip with engagement branch",
    icon: Sprout,
  },
  {
    id: "stage-change-followup",
    label: "Stage-Change Follow-up",
    hint: "Deal moves stage → follow-up task + notify",
    icon: GitBranch,
  },
  {
    id: "no-reply-followup",
    label: "No-reply Follow-up",
    hint: "Contact goes quiet → SMS nudge → task if still silent",
    icon: Reply,
  },
];

interface Row {
  id: string;
  name: string;
  status: WorkflowStatus;
  trigger: { type: WorkflowTriggerType };
  stats?: { enrolled?: number; completed?: number };
}

export function WorkflowsList({ saId }: { saId: string }) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [creating, setCreating] = useState(false);

  async function load() {
    const res = await fetch(`/api/sub-accounts/${saId}/workflows`);
    const d = (await res.json().catch(() => ({}))) as { workflows?: Row[] };
    setRows(d.workflows ?? []);
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saId]);

  async function create(template?: WorkflowTemplate) {
    setCreating(true);
    try {
      const res = await fetch(`/api/sub-accounts/${saId}/workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template: template ?? "blank" }),
      });
      const d = (await res.json()) as { id?: string };
      if (!res.ok || !d.id) throw new Error();
      router.push(`/sa/${saId}/workflows/${d.id}`);
    } catch {
      toast.error("Couldn't create workflow");
      setCreating(false);
    }
  }

  async function remove(id: string) {
    setRows((r) => r?.filter((x) => x.id !== id) ?? null);
    const res = await fetch(`/api/sub-accounts/${saId}/workflows/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      toast.error("Couldn't delete");
      void load();
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Workflows</h1>
          <p className="text-sm text-muted-foreground">
            Automate follow-up across email, SMS, tasks and more.
          </p>
        </div>
        <div className="flex gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" type="button" disabled={creating} />}
            >
              <Workflow className="mr-1 h-4 w-4" /> Start from template
              <ChevronDown className="ml-1 h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Pre-made workflows</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {TEMPLATES.map((t) => (
                  <DropdownMenuItem
                    key={t.id}
                    onClick={() => create(t.id)}
                    className="flex flex-col items-start gap-0.5"
                  >
                    <span className="flex items-center gap-2 font-medium">
                      <t.icon className="h-4 w-4" /> {t.label}
                    </span>
                    <span className="pl-6 text-xs text-muted-foreground">
                      {t.hint}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button onClick={() => create()} disabled={creating}>
            {creating ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Plus className="mr-1 h-4 w-4" />
            )}
            New workflow
          </Button>
        </div>
      </div>

      {rows === null ? (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed p-12 text-center">
          <Workflow className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No workflows yet. Create your first automation.
          </p>
        </div>
      ) : (
        <div className="divide-y overflow-hidden rounded-xl border bg-card">
          {rows.map((w) => (
            <div key={w.id} className="flex items-center gap-3 p-4 hover:bg-muted/40">
              <Link href={`/sa/${saId}/workflows/${w.id}`} className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{w.name}</span>
                  <WorkflowStatusBadge status={w.status} />
                </div>
                <div className="text-xs text-muted-foreground">
                  {TRIGGER_LABELS[w.trigger?.type] ?? w.trigger?.type} ·{" "}
                  {w.stats?.enrolled ?? 0} enrolled
                </div>
              </Link>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => remove(w.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
