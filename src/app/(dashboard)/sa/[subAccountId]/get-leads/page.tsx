"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  List,
  Loader2,
  LocateFixed,
  Lock,
  Map as MapIcon,
  MapPin,
  Plus,
  Radar,
  Search,
  Settings2,
  Star,
  Trash2,
  UserPlus,
} from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { GetLeadsMap } from "@/components/get-leads/get-leads-map";
import {
  BUSINESS_TYPES,
  customBusinessTypes,
  GET_LEADS_CUSTOM_TYPE_MAX_LEN,
  GET_LEADS_MAX_CUSTOM_TYPES,
  RADIUS_OPTIONS_KM,
  RESULT_LIMIT_OPTIONS,
  slugifyBusinessType,
} from "@/lib/get-leads/business-types";
import type { GetLeadsBusiness } from "@/types/get-leads";

/**
 * Get Leads (EXPERIMENTAL) — prospect local businesses that might need
 * websites, SEO, or automation services. Pick a business type + location +
 * radius; results come back from an Outscraper Google Maps search with
 * email/social enrichment (1–3 min) and render on a Mapbox map + an
 * enriched list. Selected rows import as contacts (source "get-leads").
 *
 * Results are ephemeral — navigate away and they're gone. Imports are the
 * durable output. Gated by `getLeadsEnabledByAgency`.
 */

type SearchPhase = "idle" | "submitting" | "polling" | "done" | "failed";
type ResultsFilter = "all" | "no-website" | "has-email";
type ResultsTab = "map" | "list";

const POLL_INTERVAL_MS = 5_000;
const POLL_CAP = 60; // ~5 minutes — enrichment occasionally dawdles.

interface SearchOrigin {
  latitude: number;
  longitude: number;
  label: string;
  radiusKm: number;
  businessType: string;
}

/** A geocoded place the operator can anchor the search to. */
interface ResolvedLocation {
  latitude: number;
  longitude: number;
  label: string;
}

/**
 * Mapbox forward geocode (v6). `autocomplete: true` powers the type-ahead
 * suggestion list; `false` is the one-shot fallback when the operator typed
 * a place without picking a suggestion. Returns [] without a token — the
 * suggestion list just never appears (geolocation still works).
 */
async function fetchPlaces(
  text: string,
  autocomplete: boolean,
): Promise<ResolvedLocation[]> {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token) return [];
  const res = await fetch(
    `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(text)}&autocomplete=${autocomplete}&limit=5&access_token=${token}`,
  );
  if (!res.ok) return [];
  const json = (await res.json()) as {
    features?: {
      geometry?: { coordinates?: [number, number] };
      properties?: { full_address?: string; name?: string; place_formatted?: string };
    }[];
  };
  return (json.features ?? []).flatMap((f) => {
    const coords = f.geometry?.coordinates;
    if (!coords) return [];
    const label =
      f.properties?.full_address ??
      [f.properties?.name, f.properties?.place_formatted]
        .filter(Boolean)
        .join(", ");
    return label
      ? [{ longitude: coords[0], latitude: coords[1], label }]
      : [];
  });
}

/** Pre-fill for the editable import tag, e.g. "plumbers-brisbane-qld". */
function defaultImportTag(origin: SearchOrigin): string {
  const locationSlug = (origin.label || "nearby")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const typeSlug = origin.businessType.replace(/^custom:/, "");
  return `${typeSlug}-${locationSlug}`.replace(/^-+|-+$/g, "").slice(0, 60);
}

export default function GetLeadsPage() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const gateOn = subAccount?.getLeadsEnabledByAgency === true;

  // Service types — admin-managed via the Manage dialog. Custom additions
  // live on `getLeadsCustomTypes`; deleted built-ins on `getLeadsHiddenTypes`
  // (presentation-only hide). Mirrored into local state so a dialog save
  // reflects immediately even if the sub-account doc snapshot lags.
  const [customLabels, setCustomLabels] = useState<string[]>([]);
  const [hiddenTypes, setHiddenTypes] = useState<string[]>([]);
  useEffect(() => {
    const stored = subAccount?.getLeadsCustomTypes;
    setCustomLabels(
      Array.isArray(stored)
        ? stored.filter((t): t is string => typeof t === "string")
        : [],
    );
    const storedHidden = subAccount?.getLeadsHiddenTypes;
    setHiddenTypes(
      Array.isArray(storedHidden)
        ? storedHidden.filter((t): t is string => typeof t === "string")
        : [],
    );
  }, [subAccount?.getLeadsCustomTypes, subAccount?.getLeadsHiddenTypes]);
  const customOptions = customBusinessTypes(customLabels);
  const visibleCurated = BUSINESS_TYPES.filter(
    (t) => !hiddenTypes.includes(t.value),
  );
  const [manageOpen, setManageOpen] = useState(false);

  // ── Form state ───────────────────────────────────────────────────
  const [businessType, setBusinessType] = useState(BUSINESS_TYPES[0].value);
  // If the selected type gets removed via the manage dialog, fall back to
  // the first visible entry so the form never submits a dead value.
  useEffect(() => {
    const valid =
      visibleCurated.some((t) => t.value === businessType) ||
      customOptions.some((t) => t.value === businessType);
    if (!valid) {
      setBusinessType(
        customOptions[0]?.value ??
          visibleCurated[0]?.value ??
          BUSINESS_TYPES[0].value,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customLabels, hiddenTypes]);
  const [locationText, setLocationText] = useState("");
  const [radiusKm, setRadiusKm] = useState<number>(10);
  // Per-search result cap = the credit budget for one run. Defaults to the
  // middle option so a first search can't silently spend the max.
  const [maxResults, setMaxResults] = useState<number>(RESULT_LIMIT_OPTIONS[1]);
  const [locating, setLocating] = useState(false);
  // The confirmed search anchor — set by picking an autocomplete suggestion
  // or by geolocation. Cleared when the operator edits the location box
  // afterwards (typed text falls back to a one-shot geocode at search time).
  const [resolvedLoc, setResolvedLoc] = useState<ResolvedLocation | null>(null);
  // Type-ahead place suggestions under the location box (debounced Mapbox
  // autocomplete). Empty without a Mapbox token — typing still works via the
  // search-time geocode fallback, and geolocation works regardless.
  const [suggestions, setSuggestions] = useState<ResolvedLocation[]>([]);
  useEffect(() => {
    const text = locationText.trim();
    if (text.length < 3 || (resolvedLoc && text === resolvedLoc.label)) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void fetchPlaces(text, true).then((places) => {
        if (!cancelled) setSuggestions(places);
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [locationText, resolvedLoc]);

  function pickSuggestion(place: ResolvedLocation) {
    setResolvedLoc(place);
    setLocationText(place.label);
    setSuggestions([]);
  }

  // ── Search state ─────────────────────────────────────────────────
  const [phase, setPhase] = useState<SearchPhase>("idle");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [businesses, setBusinesses] = useState<GetLeadsBusiness[]>([]);
  const [origin, setOrigin] = useState<SearchOrigin | null>(null);
  const pollRun = useRef(0);

  // ── Results state ────────────────────────────────────────────────
  const [tab, setTab] = useState<ResultsTab>("map");
  const [filter, setFilter] = useState<ResultsFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  // Tag applied to this import batch (alongside the constant "get-leads"
  // tag). Pre-filled from the search; editable so the operator can target
  // it later in workflow triggers / broadcast audiences / voice campaigns.
  const [importTag, setImportTag] = useState("");

  // Invalidate any in-flight poll loop on unmount.
  useEffect(() => {
    const run = pollRun;
    return () => {
      run.current++;
    };
  }, []);

  if (!gateOn) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <Header />
        <div className="rounded-2xl border border-dashed bg-card p-10 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Lock className="h-6 w-6" />
          </span>
          <h2 className="mt-4 text-base font-semibold">
            Get Leads is locked by your agency
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Ask your agency administrator to enable Get Leads for this
            sub-account.
          </p>
        </div>
      </div>
    );
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      toast.error("Your browser doesn't support geolocation.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const here = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          label: "Current location",
        };
        setResolvedLoc(here);
        setLocationText(here.label);
        setLocating(false);
        // Best-effort reverse geocode so the box shows a real place name
        // instead of the opaque "Current location". Falls back silently.
        const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
        if (!token) return;
        void fetch(
          `https://api.mapbox.com/search/geocode/v6/reverse?longitude=${here.longitude}&latitude=${here.latitude}&limit=1&access_token=${token}`,
        )
          .then((r) => (r.ok ? r.json() : null))
          .then(
            (json: {
              features?: { properties?: { full_address?: string; name?: string } }[];
            } | null) => {
              const label =
                json?.features?.[0]?.properties?.full_address ??
                json?.features?.[0]?.properties?.name;
              if (label) {
                setResolvedLoc({ ...here, label });
                setLocationText(label);
              }
            },
          )
          .catch(() => {});
      },
      () => {
        toast.error(
          "Couldn't read your location. Type a suburb or city instead.",
        );
        setLocating(false);
      },
      { timeout: 10_000 },
    );
  }

  async function handleSearch() {
    if (phase === "submitting" || phase === "polling") return;
    setSearchError(null);
    setSuggestions([]);

    // Resolve the search origin: a picked suggestion / geolocation wins;
    // otherwise one-shot geocode whatever was typed.
    let resolved: ResolvedLocation | null = null;
    const typed = locationText.trim();
    if (resolvedLoc && typed === resolvedLoc.label) {
      resolved = resolvedLoc;
    } else if (typed) {
      if (!process.env.NEXT_PUBLIC_MAPBOX_TOKEN) {
        toast.error(
          "Typed locations need NEXT_PUBLIC_MAPBOX_TOKEN configured — use “Use my location” instead.",
        );
        return;
      }
      setPhase("submitting");
      try {
        resolved = (await fetchPlaces(typed, false))[0] ?? null;
      } catch {
        resolved = null;
      }
      if (!resolved) {
        setPhase("idle");
        toast.error(`Couldn't find “${typed}” — try a fuller place name.`);
        return;
      }
    } else {
      toast.error("Type a location or use “Use my location”.");
      return;
    }

    // Don't leak the geolocation placeholder into the Google Maps query —
    // coordinates anchor the search regardless.
    const queryLabel = resolved.label === "Current location" ? "" : resolved.label;

    setPhase("submitting");
    setBusinesses([]);
    setSelected(new Set());
    setImportedIds(new Set());
    setFilter("all");

    const searchOrigin: SearchOrigin = {
      latitude: resolved.latitude,
      longitude: resolved.longitude,
      label: queryLabel,
      radiusKm,
      businessType,
    };

    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/get-leads/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessType,
          latitude: searchOrigin.latitude,
          longitude: searchOrigin.longitude,
          radiusKm,
          maxResults,
          locationLabel: searchOrigin.label,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        requestId?: string;
        error?: string;
      };
      if (!res.ok || !data.ok || !data.requestId) {
        throw new Error(data.error ?? "Couldn't start the search.");
      }
      setOrigin(searchOrigin);
      setPhase("polling");
      void pollLoop(data.requestId, searchOrigin, ++pollRun.current);
    } catch (err) {
      setPhase("failed");
      setSearchError(
        err instanceof Error ? err.message : "Couldn't start the search.",
      );
    }
  }

  async function pollLoop(
    requestId: string,
    searchOrigin: SearchOrigin,
    run: number,
  ) {
    for (let attempt = 0; attempt < POLL_CAP; attempt++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (pollRun.current !== run) return; // superseded or unmounted

      try {
        const params = new URLSearchParams({
          lat: String(searchOrigin.latitude),
          lng: String(searchOrigin.longitude),
          radiusKm: String(searchOrigin.radiusKm),
        });
        const res = await fetch(
          `/api/sub-accounts/${subAccountId}/get-leads/search/${requestId}?${params}`,
        );
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          status?: "pending" | "success" | "failed";
          businesses?: GetLeadsBusiness[];
          error?: string;
        };
        if (pollRun.current !== run) return;
        if (!res.ok) throw new Error(data.error ?? "Poll failed.");

        if (data.status === "success") {
          setBusinesses(data.businesses ?? []);
          setImportTag(defaultImportTag(searchOrigin));
          setPhase("done");
          setTab("map");
          return;
        }
        if (data.status === "failed") {
          setPhase("failed");
          setSearchError(data.error ?? "The search failed on the provider side.");
          return;
        }
        // pending → keep looping
      } catch {
        // Transient poll error — keep trying until the cap.
      }
    }
    if (pollRun.current === run) {
      setPhase("failed");
      setSearchError(
        "The search is taking longer than expected. Try again with a smaller radius.",
      );
    }
  }

  function toggleSelected(placeId: string) {
    if (importedIds.has(placeId)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(placeId)) next.delete(placeId);
      else next.add(placeId);
      return next;
    });
  }

  const filtered = businesses.filter((b) => {
    if (importedIds.has(b.placeId) && filter !== "all") return false;
    if (filter === "no-website") return !b.website;
    if (filter === "has-email") return !!b.email;
    return true;
  });
  const selectableFiltered = filtered.filter((b) => !importedIds.has(b.placeId));
  const allFilteredSelected =
    selectableFiltered.length > 0 &&
    selectableFiltered.every((b) => selected.has(b.placeId));

  function toggleSelectAllFiltered() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const b of selectableFiltered) next.delete(b.placeId);
      } else {
        for (const b of selectableFiltered) next.add(b.placeId);
      }
      return next;
    });
  }

  async function handleImport() {
    if (importing || selected.size === 0 || !origin) return;
    setImporting(true);
    try {
      const rows = businesses.filter((b) => selected.has(b.placeId));
      const res = await fetch(`/api/sub-accounts/${subAccountId}/get-leads/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businesses: rows,
          tag: importTag.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        imported?: number;
        skipped?: { name: string; reason: string }[];
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Import failed.");
      }
      const skippedCount = data.skipped?.length ?? 0;
      toast.success(
        `Imported ${data.imported ?? 0} contact${(data.imported ?? 0) === 1 ? "" : "s"}.` +
          (skippedCount > 0
            ? ` ${skippedCount} skipped (already in your contacts).`
            : ""),
      );
      setImportedIds((prev) => {
        const next = new Set(prev);
        for (const b of rows) next.add(b.placeId);
        return next;
      });
      setSelected(new Set());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setImporting(false);
    }
  }

  const searching = phase === "submitting" || phase === "polling";
  const noWebsiteCount = businesses.filter((b) => !b.website).length;
  const emailCount = businesses.filter((b) => !!b.email).length;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Header />
        {isAdmin && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setManageOpen(true)}
            disabled={searching}
            title="Add or remove your own service types"
          >
            <Settings2 className="mr-1 h-3.5 w-3.5" />
            Manage services
          </Button>
        )}
      </div>

      {/* ── Search form ─────────────────────────────────────────── */}
      <div className="rounded-2xl border bg-card p-5">
        <div className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_7rem_8rem_auto]">
          <div className="space-y-1.5">
            <Label htmlFor="gl-type">Business type</Label>
            <select
              id="gl-type"
              value={businessType}
              onChange={(e) => setBusinessType(e.target.value)}
              disabled={searching}
              className="flex h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 text-foreground dark:bg-input/30 [&_option]:bg-background [&_option]:text-foreground [&_optgroup]:bg-background [&_optgroup]:text-foreground"
            >
              {customOptions.length > 0 ? (
                <>
                  <optgroup label="Your services">
                    {customOptions.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Popular services">
                    {visibleCurated.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </optgroup>
                </>
              ) : (
                visibleCurated.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="gl-location">Location</Label>
            <div className="relative">
              <div className="flex gap-2">
                <Input
                  id="gl-location"
                  value={locationText}
                  onChange={(e) => {
                    setLocationText(e.target.value);
                    if (resolvedLoc) setResolvedLoc(null);
                  }}
                  onBlur={() => {
                    // Delay so a suggestion's onMouseDown lands first.
                    setTimeout(() => setSuggestions([]), 150);
                  }}
                  disabled={searching}
                  placeholder="Start typing a suburb, city, or postcode…"
                  autoComplete="off"
                  className="h-9"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0"
                  onClick={useMyLocation}
                  disabled={searching || locating}
                  title="Use my current location"
                >
                  {locating ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <LocateFixed className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
              {suggestions.length > 0 && !searching && (
                <ul className="absolute top-full z-20 mt-1 w-full overflow-hidden rounded-lg border bg-popover shadow-md">
                  {suggestions.map((s) => (
                    <li key={`${s.latitude},${s.longitude}`}>
                      <button
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          pickSuggestion(s);
                        }}
                        className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                      >
                        <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 truncate">{s.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="gl-radius">Radius</Label>
            <select
              id="gl-radius"
              value={radiusKm}
              onChange={(e) => setRadiusKm(Number(e.target.value))}
              disabled={searching}
              className="flex h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 text-foreground dark:bg-input/30 [&_option]:bg-background [&_option]:text-foreground"
            >
              {RADIUS_OPTIONS_KM.map((r) => (
                <option key={r} value={r}>
                  {r} km
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="gl-max">Max results</Label>
            <select
              id="gl-max"
              value={maxResults}
              onChange={(e) => setMaxResults(Number(e.target.value))}
              disabled={searching}
              title="Caps how many businesses one search returns — and how many enrichment credits it can spend"
              className="flex h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 text-foreground dark:bg-input/30 [&_option]:bg-background [&_option]:text-foreground"
            >
              {RESULT_LIMIT_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>

          <Button
            type="button"
            onClick={handleSearch}
            disabled={searching}
            className="h-9 w-full lg:w-auto"
          >
            {searching ? (
              <>
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                Searching…
              </>
            ) : (
              <>
                <Search className="mr-1 h-4 w-4" />
                Find businesses
              </>
            )}
          </Button>
        </div>

        {phase === "polling" && (
          <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Searching Google Maps and enriching contact details (emails,
            socials) for up to {maxResults} businesses — usually takes 1–3
            minutes. Leave this page open.
          </p>
        )}
        {phase === "failed" && searchError && (
          <p className="mt-3 flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
            <AlertTriangle className="h-3.5 w-3.5" />
            {searchError}
          </p>
        )}
      </div>

      {/* ── Results ─────────────────────────────────────────────── */}
      {phase === "done" && origin && (
        <div className="space-y-4">
          {/* Summary + filters + import bar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <span className="font-semibold">{businesses.length}</span>{" "}
              businesses near{" "}
              <span className="font-medium">
                {origin.label || "your location"}
              </span>{" "}
              <span className="text-muted-foreground">
                · {noWebsiteCount} without a website · {emailCount} with an
                email
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="gl-tag" className="whitespace-nowrap">
                Tag as
              </Label>
              <Input
                id="gl-tag"
                value={importTag}
                onChange={(e) => setImportTag(e.target.value)}
                disabled={importing}
                placeholder="e.g. plumbers-brisbane"
                className="h-8 w-52 text-sm"
                title="Imported contacts get this tag (plus 'get-leads') — target it in Workflows, Broadcasts, and voice campaigns"
              />
              <Button
                type="button"
                size="sm"
                onClick={handleImport}
                disabled={importing || selected.size === 0}
              >
                {importing ? (
                  <>
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    Importing…
                  </>
                ) : (
                  <>
                    <UserPlus className="mr-1 h-3.5 w-3.5" />
                    Import {selected.size > 0 ? `${selected.size} selected` : "selected"}
                  </>
                )}
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <FilterChip
              active={filter === "all"}
              onClick={() => setFilter("all")}
              label={`All (${businesses.length})`}
            />
            <FilterChip
              active={filter === "no-website"}
              onClick={() => setFilter("no-website")}
              label={`No website (${noWebsiteCount})`}
            />
            <FilterChip
              active={filter === "has-email"}
              onClick={() => setFilter("has-email")}
              label={`Has email (${emailCount})`}
            />
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-1 border-b">
            <TabButton
              active={tab === "map"}
              onClick={() => setTab("map")}
              icon={<MapIcon className="h-4 w-4" />}
              label="Map"
            />
            <TabButton
              active={tab === "list"}
              onClick={() => setTab("list")}
              icon={<List className="h-4 w-4" />}
              label={`List (${filtered.length})`}
            />
          </div>

          {tab === "map" ? (
            <div className="space-y-2">
              <GetLeadsMap
                businesses={filtered}
                origin={{
                  latitude: origin.latitude,
                  longitude: origin.longitude,
                }}
                radiusKm={origin.radiusKm}
                selected={selected}
                onToggle={toggleSelected}
              />
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-amber-600 dark:text-amber-400">
                  Amber pins
                </span>{" "}
                = no website listed. Click a pin to select it for import;
                selected pins get an indigo ring.
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-2xl border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
              Nothing matches this filter.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-2xl border bg-card">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="w-10 px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={allFilteredSelected}
                        onChange={toggleSelectAllFiltered}
                        aria-label="Select all"
                        className="h-4 w-4 cursor-pointer"
                      />
                    </th>
                    <th className="px-3 py-2.5">Business</th>
                    <th className="px-3 py-2.5">Phone</th>
                    <th className="px-3 py-2.5">Email</th>
                    <th className="px-3 py-2.5">Website</th>
                    <th className="px-3 py-2.5">Rating</th>
                    <th className="px-3 py-2.5">Address</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((b) => {
                    const imported = importedIds.has(b.placeId);
                    return (
                      <tr
                        key={b.placeId}
                        className={cn(
                          "border-b last:border-0",
                          imported
                            ? "opacity-50"
                            : "cursor-pointer hover:bg-muted/40",
                          selected.has(b.placeId) && "bg-primary/5",
                        )}
                        onClick={() => toggleSelected(b.placeId)}
                      >
                        <td className="px-3 py-2.5">
                          {imported ? (
                            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                          ) : (
                            <input
                              type="checkbox"
                              checked={selected.has(b.placeId)}
                              onChange={() => toggleSelected(b.placeId)}
                              onClick={(e) => e.stopPropagation()}
                              aria-label={`Select ${b.name}`}
                              className="h-4 w-4 cursor-pointer"
                            />
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <p className="font-medium">{b.name}</p>
                          {b.category && (
                            <p className="text-xs text-muted-foreground">
                              {b.category}
                            </p>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">
                          {b.phone ?? (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="max-w-[200px] truncate px-3 py-2.5">
                          {b.email ?? (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="max-w-[180px] truncate px-3 py-2.5">
                          {b.website ? (
                            <a
                              href={b.website}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary underline-offset-2 hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {b.website.replace(/^https?:\/\/(www\.)?/, "")}
                            </a>
                          ) : (
                            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                              No website
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5">
                          {b.rating != null ? (
                            <span className="inline-flex items-center gap-1 tabular-nums">
                              <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                              {b.rating}
                              {b.reviewsCount != null && (
                                <span className="text-xs text-muted-foreground">
                                  ({b.reviewsCount})
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="max-w-[260px] truncate px-3 py-2.5 text-xs text-muted-foreground">
                          {b.fullAddress ?? "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {phase === "idle" && (
        <div className="rounded-2xl border border-dashed bg-card p-10 text-center text-sm text-muted-foreground">
          <Radar className="mx-auto mb-3 h-8 w-8 text-muted-foreground/60" />
          Pick a business type, set a location and radius, then hit{" "}
          <strong>Find businesses</strong>. Results show on a map and an
          enriched list you can import into Contacts.
        </div>
      )}

      <ManageServicesDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        subAccountId={subAccountId}
        labels={customLabels}
        hidden={hiddenTypes}
        onSaved={(nextLabels, nextHidden) => {
          setCustomLabels(nextLabels);
          setHiddenTypes(nextHidden);
        }}
      />
    </div>
  );
}

function ManageServicesDialog({
  open,
  onOpenChange,
  subAccountId,
  labels,
  hidden,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subAccountId: string;
  labels: string[];
  hidden: string[];
  onSaved: (labels: string[], hidden: string[]) => void;
}) {
  const [list, setList] = useState<string[]>(labels);
  const [localHidden, setLocalHidden] = useState<string[]>(hidden);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  // Re-seed local state each open so consecutive opens don't show stale edits.
  useEffect(() => {
    if (open) {
      setList(labels);
      setLocalHidden(hidden);
      setDraft("");
    }
  }, [open, labels, hidden]);

  const visibleBuiltIns = BUSINESS_TYPES.filter(
    (t) => !localHidden.includes(t.value),
  );
  const visibleCount = list.length + visibleBuiltIns.length;

  function addDraft() {
    const label = draft.replace(/[\r\n\t]/g, " ").trim();
    if (label.length < 2) return;
    const slug = slugifyBusinessType(label);
    if (!slug) return;
    if (list.some((l) => slugifyBusinessType(l) === slug)) {
      toast.error("That service is already in the list.");
      return;
    }
    if (list.length >= GET_LEADS_MAX_CUSTOM_TYPES) {
      toast.error(`At most ${GET_LEADS_MAX_CUSTOM_TYPES} custom services.`);
      return;
    }
    setList((prev) => [...prev, label.slice(0, GET_LEADS_CUSTOM_TYPE_MAX_LEN)]);
    setDraft("");
  }

  function removeService(entry: { kind: "custom" | "built-in"; value: string }) {
    if (visibleCount <= 1) {
      toast.error("Keep at least one service in the list.");
      return;
    }
    if (entry.kind === "custom") {
      setList((prev) => prev.filter((l) => l !== entry.value));
    } else {
      setLocalHidden((prev) => [...prev, entry.value]);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/get-leads/types`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ types: list, hidden: localHidden }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        types?: string[];
        hidden?: string[];
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Couldn't save the services list.");
      }
      onSaved(data.types ?? list, data.hidden ?? localHidden);
      toast.success("Services list saved.");
      onOpenChange(false);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't save the services list.",
      );
    } finally {
      setSaving(false);
    }
  }

  // Combined display list — customs first (matching the picker's optgroup
  // order), then the built-ins that haven't been deleted.
  const rows: { kind: "custom" | "built-in"; value: string; label: string }[] = [
    ...list.map((l) => ({ kind: "custom" as const, value: l, label: l })),
    ...visibleBuiltIns.map((t) => ({
      kind: "built-in" as const,
      value: t.value,
      label: t.label,
    })),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Service types</DialogTitle>
          <DialogDescription>
            These are the business types in your picker. Add your own — they
            are searched exactly as written (e.g. “vegan bakeries”, “solar
            installers”) — or delete the ones you never prospect for.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addDraft();
              }
            }}
            disabled={saving}
            placeholder="Add a service, e.g. solar installers"
            maxLength={GET_LEADS_CUSTOM_TYPE_MAX_LEN}
            className="h-9"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 shrink-0"
            onClick={addDraft}
            disabled={saving || draft.trim().length < 2}
          >
            <Plus className="h-4 w-4" />
            Add
          </Button>
        </div>

        <ul className="max-h-64 space-y-2 overflow-y-auto">
          {rows.map((entry) => (
            <li
              key={`${entry.kind}:${entry.value}`}
              className="flex items-center gap-2 rounded-lg border bg-background p-2.5"
            >
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {entry.label}
              </span>
              {entry.kind === "custom" && (
                <span className="rounded-full bg-cyan-500/10 px-2 py-0.5 text-[10px] font-medium text-cyan-600 dark:text-cyan-400">
                  Custom
                </span>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={saving}
                onClick={() => removeService(entry)}
                title={`Remove ${entry.label}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>

        {localHidden.length > 0 && (
          <button
            type="button"
            onClick={() => setLocalHidden([])}
            disabled={saving}
            className="self-start text-xs font-medium text-primary hover:underline disabled:opacity-50"
          >
            Restore {localHidden.length} removed built-in service
            {localHidden.length === 1 ? "" : "s"}
          </button>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                Saving…
              </>
            ) : (
              "Save"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Header() {
  return (
    <div className="min-w-0">
      <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
        <Radar className="h-5 w-5" />
        Get Leads
        <span className="rounded-full bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-cyan-600 dark:text-cyan-400">
          Experimental
        </span>
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Find local businesses that might need what you sell — search by type
        and area, review enriched contact details, then import the good ones
        as contacts.
      </p>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
