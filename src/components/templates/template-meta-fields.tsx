"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  TEMPLATE_DESCRIPTION_MAX,
  TEMPLATE_NAME_MAX,
} from "@/types/templates";

export interface TemplateMetaValues {
  name: string;
  description: string;
  /** Comma-separated in the input; split + trimmed on submit. */
  tags: string;
}

/** Turn the comma-separated tag input into the list the API expects. */
export function splitTags(raw: string): string[] {
  return [...new Set(raw.split(",").map((t) => t.trim()).filter(Boolean))];
}

/** Name / description / tags — shared by "Save to library" and "Edit". */
export function TemplateMetaFields({
  values,
  onChange,
  idPrefix,
}: {
  values: TemplateMetaValues;
  onChange: (next: TemplateMetaValues) => void;
  idPrefix: string;
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-name`}>Name</Label>
        <Input
          id={`${idPrefix}-name`}
          value={values.name}
          maxLength={TEMPLATE_NAME_MAX}
          onChange={(e) => onChange({ ...values, name: e.target.value })}
          autoFocus
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-description`}>Description</Label>
        <Textarea
          id={`${idPrefix}-description`}
          value={values.description}
          maxLength={TEMPLATE_DESCRIPTION_MAX}
          rows={3}
          placeholder="What this is for and when to use it"
          onChange={(e) =>
            onChange({ ...values, description: e.target.value })
          }
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-tags`}>Tags</Label>
        <Input
          id={`${idPrefix}-tags`}
          value={values.tags}
          placeholder="onboarding, plumbers, follow-up"
          onChange={(e) => onChange({ ...values, tags: e.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          Comma-separated, up to 10.
        </p>
      </div>
    </div>
  );
}
