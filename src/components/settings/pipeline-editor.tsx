"use client";

import { ChevronDown, ChevronUp, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { STAGE_LABEL_MAX, PIPELINE_NAME_MAX } from "@/lib/pipelines/stages";

/** One stage row as edited. `id` is empty for a stage not yet saved. */
export interface StageRow {
  id: string;
  label: string;
  tone: string;
  terminal: "" | "won" | "lost";
}

/**
 * Name + stage list form shared by "edit pipeline" and "new pipeline".
 * Pure controlled component — the section owns the state and the save.
 */
export function PipelineEditor({
  idPrefix,
  name,
  rows,
  onName,
  onRows,
  saving,
  saveLabel,
  onSave,
  extra,
}: {
  idPrefix: string;
  name: string;
  rows: StageRow[];
  onName: (v: string) => void;
  onRows: (rows: StageRow[]) => void;
  saving: boolean;
  saveLabel: string;
  onSave: () => void;
  extra?: React.ReactNode;
}) {
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    onRows(next);
  };
  const patch = (i: number, p: Partial<StageRow>) =>
    onRows(rows.map((r, k) => (k === i ? { ...r, ...p } : r)));

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor={`${idPrefix}-name`} className="text-xs font-medium">
          Pipeline name
        </label>
        <Input
          id={`${idPrefix}-name`}
          value={name}
          onChange={(e) => onName(e.target.value)}
          maxLength={PIPELINE_NAME_MAX}
          className="h-8"
        />
      </div>

      <ul className="space-y-2" data-testid={`${idPrefix}-stages`}>
        {rows.map((r, i) => (
          <li
            key={r.id || `new-${i}`}
            className="flex items-center gap-2 rounded-lg border bg-background p-2"
          >
            <div className="flex flex-col">
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                title="Move up"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === rows.length - 1}
                className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                title="Move down"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </div>
            <span
              className={cn("h-2.5 w-2.5 shrink-0 rounded-full", r.tone.split(" ")[0])}
              aria-hidden
            />
            <Input
              aria-label={`Stage ${i + 1} label`}
              value={r.label}
              onChange={(e) => patch(i, { label: e.target.value })}
              maxLength={STAGE_LABEL_MAX}
              className="h-8 flex-1"
            />
            <select
              aria-label={`Stage ${i + 1} type`}
              value={r.terminal}
              onChange={(e) =>
                patch(i, { terminal: e.target.value as StageRow["terminal"] })
              }
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-xs text-foreground dark:bg-input/30 [&_option]:bg-background [&_option]:text-foreground"
              title="Open, or a closed Won / Lost state (drives reports + automations)"
            >
              <option value="">Open</option>
              <option value="won">Won</option>
              <option value="lost">Lost</option>
            </select>
            <button
              type="button"
              onClick={() => onRows(rows.filter((_, k) => k !== i))}
              disabled={rows.length === 1}
              className="text-muted-foreground hover:text-destructive disabled:opacity-30"
              title="Remove stage"
              aria-label={`Remove stage ${i + 1}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            onRows([...rows, { id: "", label: "", tone: "bg-slate-500/10", terminal: "" }])
          }
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add stage
        </Button>
        <Button type="button" size="sm" disabled={saving} onClick={onSave}>
          {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
          {saveLabel}
        </Button>
        {extra}
      </div>
    </div>
  );
}
