"use client";

import { FileText, Mail, Pencil, Send, Trash2, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  AgencyTemplateKind,
  AgencyTemplateSummary,
} from "@/types/templates";

export const KIND_META: Record<
  AgencyTemplateKind,
  { label: string; icon: typeof Workflow; badge: string }
> = {
  workflow: {
    label: "Workflow",
    icon: Workflow,
    badge: "bg-violet-500/10 text-violet-700 dark:text-violet-400",
  },
  email: {
    label: "Email",
    icon: Mail,
    badge: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  },
  form: {
    label: "Form",
    icon: FileText,
    badge: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
};

export function TemplateCard({
  template,
  sourceLabel,
  onPush,
  onEdit,
  onDelete,
}: {
  template: AgencyTemplateSummary;
  sourceLabel: string;
  onPush: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const meta = KIND_META[template.kind];
  const Icon = meta.icon;
  const created = template.createdAt ? new Date(template.createdAt) : null;
  return (
    <div
      data-testid="template-card"
      data-kind={template.kind}
      data-name={template.name}
      className="flex flex-col rounded-2xl border bg-card p-5 transition-all hover:border-primary/30 hover:shadow-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${meta.badge}`}
        >
          {meta.label}
          {template.includesTriggerForm ? " + trigger form" : ""}
        </span>
      </div>
      <h3 className="mt-3 truncate font-semibold" title={template.name}>
        {template.name}
      </h3>
      {template.description && (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
          {template.description}
        </p>
      )}
      {template.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {template.tags.map((t) => (
            <span
              key={t}
              className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
            >
              {t}
            </span>
          ))}
        </div>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground">
        From {sourceLabel}
        {created &&
          ` · ${created.toLocaleDateString("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
          })}`}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        <Button size="sm" onClick={onPush} data-testid="template-push-button">
          <Send className="mr-1 h-3.5 w-3.5" />
          Push to sub-accounts
        </Button>
        <Button size="sm" variant="outline" onClick={onEdit} aria-label="Edit template">
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onDelete}
          className="ml-auto text-destructive hover:text-destructive"
          aria-label="Delete template"
          data-testid="template-delete-button"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
