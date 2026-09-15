"use client";

import { useState } from "react";
import Link from "next/link";
import { Library, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AgencyTemplateKind } from "@/types/templates";
import {
  splitTags,
  TemplateMetaFields,
  type TemplateMetaValues,
} from "./template-meta-fields";

const KIND_LABEL: Record<AgencyTemplateKind, string> = {
  workflow: "workflow",
  email: "email template",
  form: "form",
};

/**
 * "Save to library" — an agency-owner-only entry point that lives on a
 * sub-account's workflow / email template / form list. Renders nothing for
 * anyone else: the route refuses non-owners too, this just keeps the button
 * out of a client team's way.
 */
export function SaveToLibraryButton({
  subAccountId,
  kind,
  entityId,
  entityName,
  iconOnly = false,
}: {
  subAccountId: string;
  kind: AgencyTemplateKind;
  entityId: string;
  entityName: string;
  iconOnly?: boolean;
}) {
  const { agencyRole } = useAuth();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [values, setValues] = useState<TemplateMetaValues>({
    name: entityName,
    description: "",
    tags: "",
  });

  if (agencyRole !== "owner") return null;

  async function handleSave() {
    if (saving) return;
    const name = values.name.trim();
    if (!name) {
      toast.error("Give the template a name.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/agency/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subAccountId,
          kind,
          entityId,
          name,
          description: values.description.trim(),
          tags: splitTags(values.tags),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        includesTriggerForm?: boolean;
      };
      if (!res.ok) throw new Error(data.error ?? "Couldn't save to library.");
      toast.success(
        data.includesTriggerForm
          ? "Saved to library, including its trigger form."
          : "Saved to library.",
        {
          action: (
            <Link href="/agency/templates" className="text-xs underline">
              Open library
            </Link>
          ),
        },
      );
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant={iconOnly ? "ghost" : "outline"}
        size={iconOnly ? "icon" : "sm"}
        className={iconOnly ? "h-8 w-8" : undefined}
        title="Save to library"
        aria-label={`Save ${entityName} to library`}
        data-testid="save-to-library"
        onClick={() => {
          setValues({ name: entityName, description: "", tags: "" });
          setOpen(true);
        }}
      >
        <Library className={iconOnly ? "h-4 w-4" : "mr-1 h-3.5 w-3.5"} />
        {!iconOnly && "Save to library"}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save to template library</DialogTitle>
            <DialogDescription>
              Copies this {KIND_LABEL[kind]} into the agency library so you can
              push it into any sub-account.
              {kind === "workflow" &&
                " A workflow triggered by a form includes its trigger form."}
            </DialogDescription>
          </DialogHeader>
          <TemplateMetaFields
            idPrefix="save-tpl"
            values={values}
            onChange={setValues}
          />
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || !values.name.trim()}
              data-testid="save-to-library-submit"
            >
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
