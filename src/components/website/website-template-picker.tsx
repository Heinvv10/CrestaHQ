"use client";

import { ExternalLink } from "lucide-react";
import { TILE_OFF, TILE_ON } from "@/components/website/website-form-parts";
import { isNicheKey, NICHE_META } from "@/lib/website/niches";

/** An Agency template as the templates route returns it (gitpage GET /api/v1/templates). */
export interface WizardTemplate {
  templateId: string;
  name: string;
  niche: string | null;
  previewUrl: string | null;
  quality: "premium" | "standard";
  /** "client": this sub-account's own template. */
  scope?: "agency" | "client";
}

/**
 * The agency's saved templates (gitpage My Sites → "Save as template"), for
 * the wizard's "Agency template" mode. Each card links to the template's
 * live site so the operator can look before picking.
 */
export function TemplatePicker({
  templates,
  value,
  onPick,
  disabled,
}: {
  templates: WizardTemplate[];
  value: string | null | undefined;
  onPick: (template: WizardTemplate) => void;
  disabled?: boolean;
}) {
  if (!templates.length) {
    return (
      <p className="text-xs text-muted-foreground">
        No templates saved yet. Open a built website&apos;s card and choose <span className="font-medium text-foreground">Save as template</span> —
        it then shows up here.
      </p>
    );
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {templates.map((t) => {
        const selected = value === t.templateId;
        const niche = t.niche && isNicheKey(t.niche) ? NICHE_META[t.niche] : null;
        return (
          <div
            key={t.templateId}
            className={(selected ? TILE_ON : TILE_OFF) + " flex flex-col gap-1.5 rounded-xl border p-3 transition-colors"}
          >
            <button
              type="button"
              onClick={() => onPick(t)}
              disabled={disabled}
              aria-pressed={selected}
              className="flex flex-col items-start gap-1 text-left disabled:cursor-not-allowed disabled:opacity-60"
            >
              <p className="text-sm font-medium">{t.name}</p>
              <p className="text-[11px] text-muted-foreground">
                {niche ? `${niche.emoji} ${niche.label}` : "Any niche"} · {t.quality === "premium" ? "Premium" : "Standard"}
                {t.scope === "client" ? " · This client only" : ""}
              </p>
            </button>
            {/* HARDENING: the server keeps only https preview URLs; checked again at the link. */}
            {t.previewUrl?.startsWith("https://") && (
              <a
                href={t.previewUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
              >
                View the template <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}
