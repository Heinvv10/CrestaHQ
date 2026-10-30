"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Phone } from "lucide-react";
import { toast } from "sonner";
import {
  getCountries,
  getCountryCallingCode,
  isSupportedCountry,
} from "libphonenumber-js";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

/**
 * Phone region — the workspace's `defaultPhoneCountry` (SubAccountDoc).
 * It's the FALLBACK country used when a phone number is typed without a
 * country code (public forms, manual entry, CSV import, chat captures) so
 * it can be stored in E.164 and match inbound SMS/WhatsApp caller IDs.
 * Numbers typed with a "+" prefix always parse as their own country —
 * this setting never restricts anything. Unset reads as US (the historic
 * behavior), so existing workspaces are unchanged until an admin picks.
 */

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 [&_option]:bg-background [&_option]:text-foreground";

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

const COUNTRY_OPTIONS = getCountries()
  .map((code) => ({
    code,
    label: regionNames.of(code) ?? code,
    calling: getCountryCallingCode(code),
  }))
  .sort((a, b) => a.label.localeCompare(b.label));

function storedCountry(raw: string | null | undefined): string {
  const code = raw?.trim().toUpperCase() ?? "";
  return code && isSupportedCountry(code) ? code : "US";
}

export function SubAccountPhoneRegionSection() {
  const { subAccount, subAccountId, isAdmin } = useSubAccount();

  const [country, setCountry] = useState("US");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setCountry(storedCountry(subAccount?.defaultPhoneCountry));
  }, [subAccount?.defaultPhoneCountry]);

  if (!isAdmin) return null;

  const dirty = country !== storedCountry(subAccount?.defaultPhoneCountry);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`/api/agency/sub-accounts/${subAccountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultPhoneCountry: country }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Could not save.");
      toast.success("Phone region saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-5">
      <div className="mb-4 flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-500/10 text-teal-600 dark:text-teal-400">
          <Phone className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold">Phone region</h2>
          <p className="text-xs text-muted-foreground">
            The country assumed when a phone number is entered without a
            country code — forms, manual entry, CSV import, and chat captures
            store it in international format so SMS replies match the right
            contact.
          </p>
        </div>
      </div>

      <form onSubmit={handleSave} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="phone-region-country">Default country</Label>
          <select
            id="phone-region-country"
            className={SELECT_CLASS}
            value={country}
            onChange={(e) => setCountry(e.target.value)}
          >
            {COUNTRY_OPTIONS.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label} (+{c.calling})
              </option>
            ))}
          </select>
          <p className="text-[11px] text-muted-foreground">
            Numbers typed with a + prefix always keep their own country —
            this only fills in the code when it&apos;s missing. Existing
            contacts are not changed.
          </p>
        </div>

        <div className="flex justify-end">
          <Button type="submit" disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </section>
  );
}
