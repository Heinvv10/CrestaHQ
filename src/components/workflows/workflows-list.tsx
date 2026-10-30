"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  CalendarCheck,
  ChevronDown,
  FolderPlus,
  GitBranch,
  Loader2,
  Plus,
  Reply,
  Sprout,
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
import { groupWorkflowsByFolder } from "@/lib/workflows/folders";
import type { WorkflowFolder } from "@/types/workflows";
import { NewFolderInput, WorkflowFolderSection } from "./workflow-folder-section";
import { WorkflowRow, type WorkflowListRow } from "./workflow-row";

/** Shown when the folder list fails to load; workflows then render flat. */
export const FOLDERS_LOAD_ERROR =
  "Couldn't load workflow folders — showing workflows without them.";

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

export function WorkflowsList({ saId }: { saId: string }) {
  const router = useRouter();
  const [rows, setRows] = useState<WorkflowListRow[] | null>(null);
  const [folders, setFolders] = useState<WorkflowFolder[]>([]);
  const [creating, setCreating] = useState(false);
  const [newFolder, setNewFolder] = useState(false);
  const [busy, setBusy] = useState(false);

  const foldersUrl = `/api/sub-accounts/${saId}/workflow-folders`;

  async function load() {
    const [wfRes, folderRes] = await Promise.all([
      fetch(`/api/sub-accounts/${saId}/workflows`),
      fetch(foldersUrl).catch(() => null),
    ]);
    const d = (await wfRes.json().catch(() => ({}))) as {
      workflows?: WorkflowListRow[];
    };
    const f = folderRes?.ok
      ? ((await folderRes.json().catch(() => null)) as {
          folders?: WorkflowFolder[];
        } | null)
      : null;
    if (!f?.folders) toast.error(FOLDERS_LOAD_ERROR);
    setFolders(f?.folders ?? []);
    setRows(d.workflows ?? []);
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saId]);

  /** A folder write; toasts the server's reason on failure, reloads on success. */
  async function folderCall(url: string, init: RequestInit, fail: string) {
    setBusy(true);
    try {
      const res = await fetch(url, {
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? fail);
        return false;
      }
      await load();
      return true;
    } catch {
      toast.error(fail);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createFolder(name: string) {
    const ok = await folderCall(
      foldersUrl,
      { method: "POST", body: JSON.stringify({ name }) },
      "Couldn't create the folder.",
    );
    if (ok) setNewFolder(false);
  }

  async function move(id: string, folderId: string | null) {
    setRows((r) => r?.map((x) => (x.id === id ? { ...x, folderId } : x)) ?? null);
    const res = await fetch(`/api/sub-accounts/${saId}/workflows/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId }),
    }).catch(() => null);
    if (!res?.ok) {
      toast.error("Couldn't move the workflow");
      void load();
    }
  }

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
          <Button
            variant="outline"
            type="button"
            data-testid="folder-new"
            onClick={() => setNewFolder(true)}
          >
            <FolderPlus className="mr-1 h-4 w-4" /> New folder
          </Button>
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

      {newFolder && (
        <NewFolderInput
          busy={busy}
          onSave={createFolder}
          onCancel={() => setNewFolder(false)}
        />
      )}

      {rows === null ? (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : rows.length === 0 && folders.length === 0 ? (
        <div className="rounded-xl border border-dashed p-12 text-center">
          <Workflow className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No workflows yet. Create your first automation.
          </p>
        </div>
      ) : (
        groupWorkflowsByFolder(rows, folders).map(({ folder, workflows }) => (
          <WorkflowFolderSection
            key={folder?.id ?? "unfiled"}
            folder={folder}
            count={workflows.length}
            busy={busy}
            onRename={(name) =>
              folderCall(
                `${foldersUrl}/${folder!.id}`,
                { method: "PATCH", body: JSON.stringify({ name }) },
                "Couldn't rename the folder.",
              )
            }
            onDelete={() =>
              void folderCall(
                `${foldersUrl}/${folder!.id}`,
                { method: "DELETE" },
                "Couldn't delete the folder.",
              )
            }
          >
            {workflows.map((w) => (
              <WorkflowRow
                key={w.id}
                saId={saId}
                workflow={w}
                folders={folders}
                onMove={(folderId) => void move(w.id, folderId)}
                onDelete={() => void remove(w.id)}
              />
            ))}
          </WorkflowFolderSection>
        ))
      )}
    </div>
  );
}
