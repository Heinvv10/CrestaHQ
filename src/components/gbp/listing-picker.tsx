"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ACCESS_NOT_APPROVED_TEXT } from "@/lib/gbp/error-text";
import type { GoogleListing } from "@/types/google";

/**
 * Pick the Business Profile location this sub-account manages. Shows enough
 * of each location (title, address, website, Place ID) that two similarly
 * named listings can be told apart. The server re-verifies the choice — this
 * component only ever sends the two resource names.
 *
 * `mode="multi"` picks the ADDITIONAL listings instead: checkboxes, the main
 * listing left out, "Save additional listings" sending the whole set plus
 * `expected` — the extras it was seeded with. A connected extra this Google
 * connection no longer shows is still listed (so it can be removed). On 409
 * listings_changed it re-seeds from the live extras.
 */

interface PickerLocation {
  name: string;
  title: string;
  address: string;
  websiteUri: string | null;
  placeId: string | null;
  mapsUri: string | null;
}

interface PickerAccount {
  name: string;
  accountName: string;
  locations: PickerLocation[];
}

type Extra = Pick<GoogleListing, "accountName" | "locationName" | "title">;
const keyOf = (l: Pick<Extra, "accountName" | "locationName">) => `${l.accountName}|${l.locationName}`;

type Load =
  | { kind: "loading" }
  | { kind: "error"; code: string }
  | { kind: "ready"; accounts: PickerAccount[]; truncated: boolean };

/** One line per refusal code the locations route can return. */
const ERROR_TEXT: Record<string, string> = {
  not_configured: "Not configured on this deployment.",
  reconnect_required: "Google no longer accepts this connection. Reconnect to continue.",
  not_connected: "Google Business Profile is not connected.",
  gate_off: "This feature is locked by your agency.",
  auth_expired: "Google rejected this connection's credentials. Try again, or reconnect if it keeps happening.",
  revoked: "Google no longer accepts this connection. Reconnect to continue.",
  insufficient_scope: "The Business Profile permission was not granted. Reconnect and leave it ticked.",
  permission_denied: "This Google account doesn't have permission to manage these listings.",
  not_found: "Google couldn't find that Business Profile account any more.",
  rate_limited: "Google is rate-limiting requests. Try again in a minute.",
  access_not_approved: ACCESS_NOT_APPROVED_TEXT,
  transient: "Google is temporarily unavailable. Try again shortly.",
  malformed: "Google sent an unexpected response. Try again shortly.",
  unknown_location: "That listing isn't available to this Google connection. Reload the list and pick again.",
  unverifiable_truncated:
    "This Google account has too many listings to verify that one here, so it can't be selected. Contact support to manage it.",
  too_many: "That is more additional listings than a workspace can manage.",
  is_main: "That listing is already the main listing.",
  no_listing: "Choose the main listing first.",
  listing_shared: "Another workspace already manages that listing.",
};

export function ListingPicker({
  subAccountId,
  onClose,
  mode = "single",
  main,
  selected = [],
}: {
  subAccountId: string;
  /** Present when a listing is already selected (the "Change listing" path). */
  onClose?: () => void;
  mode?: "single" | "multi";
  /** multi: the main listing's location name, left out of the options. */
  main?: string;
  /** multi: the connected extras (live). */
  selected?: Extra[];
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [choice, setChoice] = useState<string | null>(null);
  // What the picker was opened with — sent as `expected`.
  const [seed, setSeed] = useState<Extra[]>(selected);
  // Insertion order = the saved order: connected extras first, then new ticks.
  const [picked, setPicked] = useState<string[]>(() => selected.map(keyOf));
  const [saving, setSaving] = useState(false);
  const multi = mode === "multi";

  const fetchLocations = useCallback(async () => {
    setLoad({ kind: "loading" });
    const res = await fetch(`/api/sub-accounts/${subAccountId}/google/locations`).catch(() => null);
    const data = (await res?.json().catch(() => null)) as
      | { accounts?: PickerAccount[]; truncated?: boolean; code?: string }
      | null;
    if (!res?.ok || !data?.accounts) {
      setLoad({ kind: "error", code: data?.code ?? "error" });
      return;
    }
    setLoad({ kind: "ready", accounts: data.accounts, truncated: !!data.truncated });
  }, [subAccountId]);

  useEffect(() => {
    void fetchLocations();
  }, [fetchLocations]);

  async function select() {
    if (!multi && !choice) return;
    const pairOf = (v: string) => {
      const [accountName, locationName] = v.split("|");
      return { accountName, locationName };
    };
    setSaving(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/google/${multi ? "extra-listings" : "listing"}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          multi ? { listings: picked.map(pairOf), expected: seed.map((l) => pairOf(keyOf(l))) } : pairOf(choice!),
        ),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; code?: string; error?: string };
      if (multi && data.code === "listings_changed") {
        toast.error("Listings changed — reopened with the latest");
        setSeed(selected);
        setPicked(selected.map(keyOf));
        void fetchLocations();
        return;
      }
      if (!res.ok || !data.ok) {
        toast.error(ERROR_TEXT[data.code ?? ""] ?? data.error ?? "Couldn't save the listing.");
        return;
      }
      toast.success(multi ? "Additional listings saved." : "Listing selected.");
      onClose?.();
    } catch {
      toast.error("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  // "Change listing" must always have a way back, whatever state loads.
  const cancel = onClose && (
    <Button type="button" size="sm" variant="outline" onClick={onClose}>
      Cancel
    </Button>
  );

  if (load.kind === "loading") {
    return (
      <div className="space-y-3">
        <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="gbp-picker-loading">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading your Business Profile listings…
        </p>
        {cancel}
      </div>
    );
  }

  if (load.kind === "error") {
    return (
      <div className="space-y-3" data-testid="gbp-picker-error">
        <p className="text-sm text-destructive">
          {ERROR_TEXT[load.code] ?? `Couldn't load listings from Google (${load.code}).`}
        </p>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => void fetchLocations()}>
            Try again
          </Button>
          {cancel}
        </div>
      </div>
    );
  }

  const accounts = load.accounts.map((a) => ({ ...a, locations: a.locations.filter((l) => !multi || l.name !== main) }));
  const options = accounts.flatMap((a) => a.locations.map((l) => ({ account: a, location: l })));
  const walked = new Set(options.map((o) => `${o.account.name}|${o.location.name}`));
  const missing = multi ? seed.filter((l) => !walked.has(keyOf(l))) : [];
  const toggle = (value: string) =>
    setPicked((p) => (p.includes(value) ? p.filter((v) => v !== value) : [...p, value]));
  if (options.length === 0 && missing.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground" data-testid="gbp-picker-empty">
          {multi
            ? "This Google account doesn't manage any other Business Profile locations."
            : "This Google account doesn't manage any Business Profile locations."}
        </p>
        {cancel}
      </div>
    );
  }

  const indexOf = new Map(options.map((o, i) => [`${o.account.name}|${o.location.name}`, i]));
  return (
    <div className="space-y-4">
      {load.truncated && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          This Google account has more listings than can be shown here; only the first ones are listed.
        </p>
      )}
      {accounts.filter((a) => a.locations.length > 0).map((account) => (
        <fieldset key={account.name} className="space-y-2">
          <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {account.accountName}
          </legend>
          {account.locations.map((l) => {
            const value = `${account.name}|${l.name}`;
            return (
              <label
                key={l.name}
                data-testid={`gbp-location-option-${indexOf.get(value)}`}
                className="flex cursor-pointer items-start gap-3 rounded-lg border bg-background p-3 has-[:checked]:border-primary"
              >
                <input
                  type={multi ? "checkbox" : "radio"}
                  name="gbp-location"
                  value={value}
                  checked={multi ? picked.includes(value) : choice === value}
                  onChange={() => (multi ? toggle(value) : setChoice(value))}
                  className="mt-1"
                />
                <span className="min-w-0 space-y-0.5 text-sm">
                  <span className="block font-medium">{l.title}</span>
                  <span className="block text-muted-foreground">{l.address || "No storefront address"}</span>
                  {l.websiteUri && <span className="block truncate text-xs text-muted-foreground">{l.websiteUri}</span>}
                  {l.placeId && <span className="block text-xs text-muted-foreground">Place ID: {l.placeId}</span>}
                </span>
              </label>
            );
          })}
        </fieldset>
      ))}
      {missing.map((l, i) => (
        <label
          key={keyOf(l)}
          data-testid={`gbp-location-missing-${i}`}
          className="flex cursor-pointer items-start gap-3 rounded-lg border bg-background p-3 has-[:checked]:border-primary"
        >
          <input type="checkbox" value={keyOf(l)} checked={picked.includes(keyOf(l))} onChange={() => toggle(keyOf(l))} className="mt-1" />
          <span className="min-w-0 space-y-0.5 text-sm">
            <span className="block font-medium">{l.title}</span>
            <span className="block text-muted-foreground">not visible in this Google connection</span>
          </span>
        </label>
      ))}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={(!multi && !choice) || saving}
          onClick={() => void select()}
          data-testid={multi ? "gbp-save-extra-listings" : "gbp-select-listing"}
        >
          {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
          {multi ? "Save additional listings" : "Select listing"}
        </Button>
        {cancel}
      </div>
    </div>
  );
}
