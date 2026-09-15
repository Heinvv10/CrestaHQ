"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AgencyTemplateSummary } from "@/types/templates";
import {
  splitTags,
  TemplateMetaFields,
  type TemplateMetaValues,
} from "./template-meta-fields";

/** Rename / re-describe / re-tag a library template. The payload is fixed. */
export function EditTemplateDialog({
  template,
  open,
  onOpenChange,
  onSaved,
}: {
  template: AgencyTemplateSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [values, setValues] = useState<TemplateMetaValues>({
    name: "",
    description: "",
    tags: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (template && open) {
      setValues({
        name: template.name,
        description: template.description,
        tags: template.tags.join(", "),
      });
    }
  }, [template, open]);

  async function handleSave() {
    if (!template || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/agency/templates/${template.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: values.name.trim(),
          description: values.description.trim(),
          tags: splitTags(values.tags),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't save.");
      toast.success("Template updated.");
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit template</DialogTitle>
        </DialogHeader>
        <TemplateMetaFields
          idPrefix="edit-tpl"
          values={values}
          onChange={setValues}
        />
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || !values.name.trim()}
            data-testid="template-edit-submit"
          >
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
