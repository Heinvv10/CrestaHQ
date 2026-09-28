"use client";

import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Image as ImageIcon, Save } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { normalizePhoneE164 } from "@/lib/contacts/phone";

/**
 * Sub-account branding settings: logo URL, which renders on quote/invoice
 * emails, public /q/[token] pages, and PDFs; and (R2) an optional WhatsApp
 * number for the public prospect report's CTA button.
 *
 * Distinct from agency-level branding (which controls the CRM sidebar +
 * landing page). Agency owners and sub-account admins can both edit.
 */

const URL_RE = /^https?:\/\/.+/i;

export function SubAccountBrandingSection() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const [logoUrl, setLogoUrl] = useState("");
  const [whatsappNumber, setWhatsappNumber] = useState("");
  const [saving, setSaving] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate once when the snapshot resolves. Don't reset on subsequent
  // ticks so the operator's in-flight edits aren't blown away by their
  // own save echo.
  useEffect(() => {
    if (!hydrated && subAccount) {
      setLogoUrl(subAccount.logoUrl ?? "");
      setWhatsappNumber(subAccount.whatsappNumber ?? "");
      setHydrated(true);
    }
  }, [hydrated, subAccount]);

  if (!isAdmin) return null;

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    const trimmed = logoUrl.trim();
    if (trimmed && !URL_RE.test(trimmed)) {
      toast.error("Logo URL must start with http:// or https://.");
      return;
    }
    const trimmedNumber = whatsappNumber.trim();
    const e164 = trimmedNumber ? normalizePhoneE164(trimmedNumber, subAccount?.defaultPhoneCountry) : null;
    if (trimmedNumber && !e164) {
      toast.error("WhatsApp number must be a valid E.164 phone number, e.g. +27821234567.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/branding`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logoUrl: trimmed || null, whatsappNumber: e164 }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Couldn't save branding.");
      }
      toast.success("Branding saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  const previewValid = logoUrl.trim() && URL_RE.test(logoUrl.trim());
  const businessName = subAccount?.name ?? "Your client";

  return (
    <form onSubmit={handleSave} className="space-y-5 rounded-2xl border bg-card p-5">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400">
          <ImageIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Branding</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Logo that appears on{" "}
            <strong className="text-foreground">{businessName}</strong>
            &apos;s quote/invoice emails, public link pages, and PDFs.
            Doesn&apos;t affect the CRM sidebar (that&apos;s agency-level).
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="sa-logo-url">Logo URL</Label>
        <Input
          id="sa-logo-url"
          type="url"
          value={logoUrl}
          onChange={(e) => setLogoUrl(e.target.value)}
          placeholder={`https://yourcdn.com/${
            businessName.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "logo"
          }.png`}
        />
        <p className="text-[11px] text-muted-foreground">
          Public https URL pointing at {businessName}&apos;s logo (PNG with
          transparent background works best). Renders at 32&ndash;40px
          tall. Leave blank to fall back to &ldquo;{businessName}&rdquo; in text.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="sa-whatsapp-number">WhatsApp number</Label>
        <Input
          id="sa-whatsapp-number"
          type="tel"
          value={whatsappNumber}
          onChange={(e) => setWhatsappNumber(e.target.value)}
          placeholder="+27821234567"
        />
        <p className="text-[11px] text-muted-foreground">
          Powers the WhatsApp button on {businessName}&apos;s public prospect
          report. Leave blank to use the connected WhatsApp Cloud number
          instead; the button is hidden when neither is set.
        </p>
      </div>

      {/* Live preview — what the recipient will see on a quote/invoice header. */}
      <div className="rounded-xl border bg-background p-4">
        <p className="mb-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Invoice header preview
        </p>
        <div className="flex items-center gap-3">
          {previewValid ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl.trim()}
              alt={businessName}
              className="h-9 w-auto max-w-[160px] object-contain"
            />
          ) : (
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">
              {businessName.slice(0, 2).toUpperCase()}
            </span>
          )}
          <div>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Invoice from
            </p>
            <p className="text-lg font-semibold tracking-tight">
              {businessName}
            </p>
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <Button type="submit" disabled={saving || !hydrated}>
          <Save className="mr-1 h-3.5 w-3.5" />
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
