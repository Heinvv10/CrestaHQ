"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_TEMPLATE_BUTTONS } from "@/lib/comms/whatsapp/template-validation";
import type { WhatsappTemplateButton } from "@/types/whatsapp-templates";

/**
 * Buttons on a WhatsApp template: quick replies (the tap comes back as the
 * customer's reply, so a workflow can branch on its text) and links. The
 * server validates and orders them; this only edits the list.
 */
export function WhatsappTemplateButtonsEditor({
  value,
  onChange,
}: {
  value: WhatsappTemplateButton[];
  onChange: (next: WhatsappTemplateButton[]) => void;
}) {
  const update = (i: number, next: WhatsappTemplateButton) =>
    onChange(value.map((b, j) => (j === i ? next : b)));

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <Label className="text-xs font-medium">Buttons (optional)</Label>
      {value.map((b, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <select
            value={b.type}
            aria-label={`Button ${i + 1} type`}
            onChange={(e) =>
              update(
                i,
                e.target.value === "url"
                  ? { type: "url", text: b.text, url: "" }
                  : { type: "quick_reply", text: b.text },
              )
            }
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            <option value="quick_reply">Quick reply</option>
            <option value="url">Link</option>
          </select>
          <Input
            value={b.text}
            maxLength={25}
            onChange={(e) => update(i, { ...b, text: e.target.value })}
            placeholder="Button text"
            className="h-9 w-44"
          />
          {b.type === "url" && (
            <Input
              value={b.url}
              onChange={(e) => update(i, { ...b, url: e.target.value })}
              placeholder="https://…"
              className="h-9 min-w-0 flex-1"
            />
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Remove button ${i + 1}`}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={value.length >= MAX_TEMPLATE_BUTTONS}
        onClick={() => onChange([...value, { type: "quick_reply", text: "" }])}
      >
        <Plus className="mr-1 h-3.5 w-3.5" /> Add button
      </Button>
      <p className="text-[11px] text-muted-foreground">
        Up to {MAX_TEMPLATE_BUTTONS}. A quick reply comes back as the
        customer&apos;s reply — branch on its text after a &ldquo;Wait for
        reply&rdquo; step. A link opens a page and sends nothing back.
      </p>
    </div>
  );
}
