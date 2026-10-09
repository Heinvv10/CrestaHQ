"use client";

import { useState } from "react";
import { Loader2, Plus, Timer, X } from "lucide-react";
import { toast } from "sonner";

import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_TEMPLATES, TEMPLATE_MAX_LEN } from "@/lib/prospecting/mystery-shop/enquiry";
import { JOB_VALUE_DEFAULT_CENTS } from "@/lib/prospecting/mystery-shop/model";
import { formatMoney } from "@/lib/prospecting/mystery-shop/section";
import type { MysteryShopTemplates } from "@/types";
import { MysteryShopWhatsappTemplate } from "./mystery-shop-whatsapp-template";

/**
 * Prospecting page → Mystery shop settings (sub-account admins): the value of
 * one job per niche, used for a missed lead, the enquiry wording and the
 * WhatsApp enquiry template (mystery-shop-whatsapp-template.tsx). Saved
 * through PUT …/prospecting/mystery-shop/settings, which validates; the page
 * reads the stored values back from the live sub-account doc.
 */

type Row = { niche: string; rands: string };
const TEMPLATE_FIELDS: { key: keyof typeof DEFAULT_TEMPLATES; label: string; rows: number }[] = [
  { key: "emailSubject", label: "Email subject", rows: 1 },
  { key: "emailBody", label: "Email body", rows: 6 },
  { key: "call", label: "AI call opening line", rows: 3 },
];

export function MysteryShopSettingsCard() {
  const { subAccount, subAccountId, isAdmin } = useSubAccount();
  const [rows, setRows] = useState<Row[]>(() =>
    Object.entries(subAccount?.prospectingJobValues ?? {}).map(([niche, cents]) => ({ niche, rands: String(cents / 100) })),
  );
  // The wording only: the WhatsApp template choice is saved as its own field.
  const [templates, setTemplates] = useState<MysteryShopTemplates>(() => {
    const { whatsappTemplateId: _id, ...wording } = subAccount?.prospectingMysteryShopTemplates ?? {};
    return wording;
  });
  const [waTemplateId, setWaTemplateId] = useState<string | null>(
    () => subAccount?.prospectingMysteryShopTemplates?.whatsappTemplateId ?? null,
  );
  const [saving, setSaving] = useState(false);
  if (!isAdmin) return null;

  const save = async () => {
    const jobValues: Record<string, number> = {};
    for (const r of rows) {
      if (!r.niche.trim()) continue;
      const cents = Math.round(Number(r.rands) * 100);
      if (!r.rands.trim() || !Number.isFinite(cents) || cents < 0) {
        toast.error(`Enter a value in rands for ${r.niche.trim()}.`);
        return;
      }
      jobValues[r.niche.trim()] = cents;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/prospecting/mystery-shop/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobValues, templates, whatsappTemplateId: waTemplateId }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Failed (HTTP ${res.status})`);
      toast.success("Mystery shop settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4 rounded-2xl border bg-card p-5" data-testid="mystery-shop-settings">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Timer className="h-4 w-4" />
          Mystery shop settings
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A missed lead is valued at one job in the prospect&rsquo;s niche — {formatMoney(JOB_VALUE_DEFAULT_CENTS, "ZAR")} unless
          you set it here. The niche is the prospect&rsquo;s business category.
        </p>
      </div>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={r.niche}
              maxLength={60}
              placeholder="Niche, e.g. plumber"
              aria-label="Niche"
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, niche: e.target.value } : x)))}
            />
            <Input
              type="number"
              min={0}
              step="0.01"
              className="w-36"
              value={r.rands}
              placeholder="Rands"
              aria-label="Job value in rands"
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, rands: e.target.value } : x)))}
            />
            <Button type="button" size="sm" variant="ghost" aria-label="Remove niche" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <Button type="button" size="sm" variant="outline" disabled={rows.length >= 50} onClick={() => setRows([...rows, { niche: "", rands: "" }])}>
          <Plus className="h-4 w-4" />
          Add niche
        </Button>
      </div>
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          The enquiry. Leave a field empty for the neutral default. {"{service}"}, {"{town}"} and {"{business}"} are filled in
          per prospect.
        </p>
        {TEMPLATE_FIELDS.map((f) => (
          <label key={f.key} className="block space-y-1 text-sm">
            <span className="font-medium">{f.label}</span>
            <Textarea
              rows={f.rows}
              maxLength={TEMPLATE_MAX_LEN}
              value={templates[f.key] ?? ""}
              placeholder={DEFAULT_TEMPLATES[f.key]}
              onChange={(e) => setTemplates({ ...templates, [f.key]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <MysteryShopWhatsappTemplate subAccountId={subAccountId} value={waTemplateId} onChange={setWaTemplateId} />
      <Button type="button" size="sm" onClick={() => void save()} disabled={saving}>
        {saving && <Loader2 className="h-4 w-4 animate-spin" />}
        Save
      </Button>
    </section>
  );
}
