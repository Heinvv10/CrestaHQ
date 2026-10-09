"use client";

import { useEffect, useState } from "react";

import {
  SPEED_CHECK_TEMPLATE_NAME,
  cloudTemplateStatus,
  hasTwoVariables,
  missingTemplateReason,
  pickShopTemplate,
  templateProblem,
} from "@/lib/prospecting/mystery-shop/whatsapp-template";
import type { WhatsappTemplateDoc } from "@/types/whatsapp-templates";

/**
 * Mystery shop settings → the WhatsApp enquiry template (PR 5b): which
 * template is used, its status on the Meta (Cloud) account as a badge, and
 * the reason it can't send yet — the same words the Reports card shows. The
 * select offers only templates with exactly two variables ({{1}} service,
 * {{2}} town); the parent saves the choice as `whatsappTemplateId` (null =
 * the template named leadstack_speed_check).
 */

const STATUS_STYLES: Record<string, string> = {
  approved: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  pending: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  submitting: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  rejected: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
  failed: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
};

export function MysteryShopWhatsappTemplate({
  subAccountId,
  value,
  onChange,
}: {
  subAccountId: string;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [templates, setTemplates] = useState<WhatsappTemplateDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/sub-accounts/${subAccountId}/whatsapp-templates`)
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { templates?: WhatsappTemplateDoc[]; error?: string };
        if (!res.ok) throw new Error(body.error ?? `Failed (HTTP ${res.status})`);
        if (live) setTemplates(body.templates ?? []);
      })
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : "Couldn't load WhatsApp templates"));
    return () => {
      live = false;
    };
  }, [subAccountId]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!templates) return <p className="text-sm text-muted-foreground">Loading WhatsApp templates…</p>;

  const current = pickShopTemplate(templates, value);
  const status = current ? cloudTemplateStatus(current).status : null;
  const problem = current ? templateProblem(current) : missingTemplateReason(!!value);

  return (
    <div className="space-y-2 text-sm">
      <label className="block space-y-1">
        <span className="font-medium">WhatsApp enquiry template</span>
        <select
          className="block w-full rounded-md border bg-background px-2 py-1.5"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
          data-testid="mystery-shop-wa-template-select"
        >
          <option value="">Default: {SPEED_CHECK_TEMPLATE_NAME}</option>
          {templates.filter(hasTwoVariables).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      {current && (
        <p className="flex items-center gap-2">
          <span data-testid="mystery-shop-wa-template-name">{current.name}</span>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ${STATUS_STYLES[status ?? ""] ?? "bg-muted"}`}
            data-testid="mystery-shop-wa-template-status"
          >
            {status}
          </span>
        </p>
      )}
      {problem && (
        <p className="text-xs text-muted-foreground" data-testid="mystery-shop-wa-template-problem">
          {problem}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        A business-initiated WhatsApp must be a Meta-approved template with two variables: {"{{1}}"} the service and{" "}
        {"{{2}}"} the town. It sends from your WhatsApp Cloud number.
      </p>
    </div>
  );
}
