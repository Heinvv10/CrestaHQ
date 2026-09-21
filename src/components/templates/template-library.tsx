"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Library, Search } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  AgencyTemplateKind,
  AgencyTemplateSummary,
} from "@/types/templates";
import { EditTemplateDialog } from "./edit-template-dialog";
import {
  PushTemplateDialog,
  subLabel,
  type SubOption,
} from "./push-template-dialog";
import { TemplateCard } from "./template-card";

type KindFilter = "all" | AgencyTemplateKind;

const KIND_TABS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "workflow", label: "Workflows" },
  { value: "email", label: "Emails" },
  { value: "form", label: "Forms" },
];

const selectClass =
  "h-9 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

/**
 * Agency template library: every single-entity template the owner saved
 * from a sub-account, filterable by kind / tag / text, with push, edit and
 * delete per card.
 */
export function TemplateLibrary({ subs }: { subs: SubOption[] }) {
  const [templates, setTemplates] = useState<AgencyTemplateSummary[] | null>(null);
  const [kind, setKind] = useState<KindFilter>("all");
  const [tag, setTag] = useState("");
  const [search, setSearch] = useState("");
  const [pushing, setPushing] = useState<AgencyTemplateSummary | null>(null);
  const [editing, setEditing] = useState<AgencyTemplateSummary | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/agency/templates");
      const data = (await res.json().catch(() => ({}))) as {
        templates?: AgencyTemplateSummary[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Failed to load templates.");
      setTemplates(data.templates ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load.");
      setTemplates([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const allTags = useMemo(
    () => [...new Set((templates ?? []).flatMap((t) => t.tags))].sort(),
    [templates],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (templates ?? []).filter(
      (t) =>
        (kind === "all" || t.kind === kind) &&
        (!tag || t.tags.includes(tag)) &&
        (!q ||
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.tags.some((x) => x.toLowerCase().includes(q))),
    );
  }, [templates, kind, tag, search]);

  const sourceLabel = (id: string) => {
    const s = subs.find((x) => x.id === id);
    return s ? subLabel(s) : id ? id.slice(0, 8) : "—";
  };

  async function handleDelete(t: AgencyTemplateSummary) {
    if (!confirm(`Delete "${t.name}" from the library? Copies already pushed stay where they are.`)) {
      return;
    }
    try {
      const res = await fetch(`/api/agency/templates/${t.id}`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't delete.");
      toast.success("Template deleted.");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete.");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={kind} onValueChange={(v) => setKind(v as KindFilter)}>
          <TabsList>
            {KIND_TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          <select
            className={selectClass}
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            aria-label="Filter by tag"
          >
            <option value="">All tags</option>
            {allTags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search templates"
              className="h-9 w-56 pl-7"
              aria-label="Search templates"
            />
          </div>
        </div>
      </div>

      {templates === null ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-44 animate-pulse rounded-2xl border bg-muted/30" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-dashed bg-card/50 p-10 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Library className="h-5 w-5" />
          </div>
          <h3 className="text-base font-semibold">
            {templates.length === 0 ? "Your library is empty" : "No templates match"}
          </h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            {templates.length === 0
              ? "Open a sub-account's workflows, email templates or forms and use “Save to library” on the one you want to reuse."
              : "Try another kind, tag or search."}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((t) => (
            <TemplateCard
              key={t.id}
              template={t}
              sourceLabel={sourceLabel(t.sourceSubAccountId)}
              onPush={() => setPushing(t)}
              onEdit={() => setEditing(t)}
              onDelete={() => handleDelete(t)}
            />
          ))}
        </div>
      )}

      <PushTemplateDialog
        template={pushing}
        subs={subs}
        open={pushing !== null}
        onOpenChange={(open) => !open && setPushing(null)}
      />
      <EditTemplateDialog
        template={editing}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={load}
      />
    </div>
  );
}
