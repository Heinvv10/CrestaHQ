"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { GitBranch } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { usePipelines } from "@/hooks/use-pipeline-stages";
import { Button } from "@/components/ui/button";
import type { PipelineDoc } from "@/types/deals";
import { PipelineEditor, type StageRow } from "./pipeline-editor";

/**
 * Pipelines section — create / rename / delete pipelines and add / rename /
 * reorder / delete their stages, mark Won / Lost. Admin-only. All writes go
 * through /api/sub-accounts/[id]/pipelines; the server refuses deleting a
 * stage or pipeline that still holds deals (409), surfaced as a toast.
 */

const NEW = "__new__";

function rowsOf(p: PipelineDoc): StageRow[] {
  return p.stages.map((s) => ({
    id: s.id,
    label: s.label,
    tone: s.tone,
    terminal: s.terminal ?? "",
  }));
}

function toStagesPayload(rows: StageRow[]) {
  return rows.map((r) => ({
    ...(r.id ? { id: r.id } : {}),
    label: r.label.trim(),
    terminal: r.terminal || null,
  }));
}

async function readError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error ?? "Something went wrong. Please try again.";
}

export function SubAccountPipelineSection() {
  const { subAccountId, isAdmin, refreshPipelines } = useSubAccount();
  const { pipelines, defaultPipeline } = usePipelines();
  const [selectedId, setSelectedId] = useState<string>(defaultPipeline.id);
  const selected =
    selectedId === NEW ? null : (pipelines.find((p) => p.id === selectedId) ?? defaultPipeline);

  const [name, setName] = useState("");
  const [rows, setRows] = useState<StageRow[]>([]);
  const [saving, setSaving] = useState(false);

  // Re-seed the form when the selection or the saved doc changes.
  useEffect(() => {
    if (selected) {
      setName(selected.name);
      setRows(rowsOf(selected));
    } else {
      setName("");
      setRows([{ id: "", label: "New", tone: "bg-slate-500/10", terminal: "" }]);
    }
  }, [selected]);

  if (!isAdmin) return null;

  const base = `/api/sub-accounts/${subAccountId}/pipelines`;

  async function save() {
    if (rows.some((r) => !r.label.trim())) {
      toast.error("Every stage needs a label.");
      return;
    }
    setSaving(true);
    try {
      const body = JSON.stringify({ name: name.trim(), stages: toStagesPayload(rows) });
      const res = selected
        ? await fetch(`${base}/${selected.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body })
        : await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      await refreshPipelines();
      if (!selected) {
        const { id } = (await res.json()) as { id: string };
        setSelectedId(id);
        toast.success("Pipeline created.");
      } else {
        toast.success("Pipeline updated.");
      }
    } catch {
      toast.error("Couldn't save the pipeline. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!selected || selected.isDefault) return;
    if (!confirm(`Delete the "${selected.name}" pipeline?`)) return;
    setSaving(true);
    try {
      const res = await fetch(`${base}/${selected.id}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      setSelectedId(defaultPipeline.id);
      await refreshPipelines();
      toast.success("Pipeline deleted.");
    } catch {
      toast.error("Couldn't delete the pipeline. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
          <GitBranch className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Pipelines</h2>
          <p className="text-xs text-muted-foreground">
            Run more than one deal pipeline, each with its own stages. Mark
            one stage Won and one Lost per pipeline — those closed states
            drive reports and the deal won / lost automations. A stage or
            pipeline that still holds deals can&apos;t be deleted.
          </p>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          aria-label="Edit pipeline"
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground dark:bg-input/30 [&_option]:bg-background [&_option]:text-foreground"
        >
          {pipelines.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.isDefault ? " (default)" : ""}
            </option>
          ))}
          {selectedId === NEW && <option value={NEW}>New pipeline…</option>}
        </select>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={selectedId === NEW}
          onClick={() => setSelectedId(NEW)}
        >
          New pipeline
        </Button>
      </div>

      <PipelineEditor
        idPrefix="pipeline"
        name={name}
        rows={rows}
        onName={setName}
        onRows={setRows}
        saving={saving}
        saveLabel={selected ? "Save pipeline" : "Create pipeline"}
        onSave={save}
        extra={
          selected && !selected.isDefault ? (
            <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={remove}>
              Delete pipeline
            </Button>
          ) : selectedId === NEW ? (
            <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => setSelectedId(defaultPipeline.id)}>
              Cancel
            </Button>
          ) : null
        }
      />
    </section>
  );
}
