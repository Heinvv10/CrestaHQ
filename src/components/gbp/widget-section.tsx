"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Globe, Loader2 } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { widgetDisplay, type OriginReason } from "@/lib/gbp/feed/origins";
import type { GbpWidgetLayout, GbpWidgetMeta, GbpWidgetTheme } from "@/types/google";
import { InlineConfirm } from "./inline-confirm";
import { WidgetPreview } from "./widget-preview";

/**
 * The public reviews widget card on the Google Business page (admins only).
 * State is the live `gbpWidgetMeta` on the sub-account doc; every change is a
 * call to /api/sub-accounts/[id]/gbp/widget, whose answer is shown at once and
 * held until the doc's next snapshot (Firestore's Listen stream can sit silent
 * for ~30 s after a write). With the agency gate off only
 * Revoke remains (the API allows DELETE ungated). There is deliberately no
 * rating filter. No confirm()/alert(): inline confirms only.
 */

const REASONS: Record<OriginReason, string> = {
  not_a_string: "is not text",
  not_a_url: "is not a web address (e.g. https://www.example.com)",
  wildcard: "wildcards are not allowed",
  credentials: "must not contain a username or password",
  path: "must be just scheme://host[:port] — no path, query or #",
  https_required: "must use https (plain http only for localhost / 127.0.0.1)",
  scheme: "must use https",
};

const LAYOUTS: Array<[GbpWidgetLayout, string]> = [["carousel", "Carousel"], ["grid", "Grid"], ["list", "List"], ["badge", "Badge"]];
const THEMES: Array<[GbpWidgetTheme, string]> = [["light", "Light"], ["dark", "Dark"]];
const field = "h-9 rounded-md border bg-background px-2 text-sm";

type Refusal = { error?: string; code?: string; details?: Array<{ value: string; reason: OriginReason }> };

const appUrl = () => (process.env.NEXT_PUBLIC_APP_URL || window.location.origin).replace(/\/+$/, "");

/** For text pasted into someone else's HTML: attribute-safe. */
const escapeHtml = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function httpUrl(v: string | null | undefined): string | null {
  try {
    const u = new URL(v ?? "");
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

function snippetFor(publicId: string, mapsUri: string | null | undefined): string {
  const app = escapeHtml(appUrl());
  const id = escapeHtml(publicId);
  const link = escapeHtml(httpUrl(mapsUri) ?? "https://www.google.com/maps");
  return [
    `<div data-crestahq-reviews="${id}" data-api="${app}">`,
    `  <!-- Static fallback: shown as-is when JavaScript is off or the feed is unavailable. -->`,
    `  <p><a href="${link}">Read our reviews on Google</a></p>`,
    `</div>`,
    `<script src="${app}/embed/gbp-reviews.js" defer></script>`,
  ].join("\n");
}

/** The saved settings that change what the preview draws. */
function previewVersion(meta: GbpWidgetMeta): string {
  const { layout, theme } = widgetDisplay(meta);
  return [meta.enabled, meta.maxReviews, layout, theme].join("|");
}

async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; data: Refusal & { widget?: GbpWidgetMeta } }> {
  const res = await fetch(url, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }).catch(() => null);
  const data = ((await res?.json().catch(() => null)) ?? {}) as Refusal & { widget?: GbpWidgetMeta };
  return { ok: !!res?.ok, data };
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="mt-4 rounded-2xl border bg-card p-6" data-testid="gbp-widget-card">
      <header className="mb-3 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          <Globe className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-base font-semibold">Reviews on your website</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            A public feed of this listing&apos;s Google reviews — every rating, newest first — for an allowed website to embed.
            Settings changes reach visitors within about a minute; newly synced reviews within about two minutes.
          </p>
        </div>
      </header>
      {children}
    </section>
  );
}

export function WidgetSection() {
  const { subAccountId, subAccount, isAdmin, loading } = useSubAccount();
  // The last call's answer, pinned to the snapshot on screen when it was
  // made: any newer snapshot of the doc wins over it.
  const [answered, setAnswered] = useState<{ meta: GbpWidgetMeta | null; doc: unknown } | null>(null);
  if (loading || !isAdmin || !subAccount) return null;
  const meta = answered && answered.doc === subAccount ? answered.meta : (subAccount.gbpWidgetMeta ?? null);
  const settle = (next: GbpWidgetMeta | null) => setAnswered({ meta: next, doc: subAccount });
  const api = `/api/sub-accounts/${subAccountId}/gbp/widget`;
  const revoke = (
    <InlineConfirm
      label="Revoke widget"
      confirmLabel="Yes, revoke"
      prompt="Delete this widget? Sites using it fall back to their static content."
      onConfirm={async () => {
        const { ok, data } = await call(api, "DELETE");
        if (ok) {
          settle(null);
          toast.success("Widget revoked.");
        } else toast.error(data.error ?? "That didn't work. Please try again.");
      }}
      testId="gbp-widget-revoke"
    />
  );

  if (subAccount.googleEnabledByAgency !== true) {
    if (!meta) return null;
    return (
      <Card>
        <p className="mb-3 text-sm text-muted-foreground">This feature is locked by your agency. You can still take the widget down.</p>
        {revoke}
      </Card>
    );
  }
  return (
    <Card>
      <WidgetForm key={meta?.publicId ?? "new"} api={api} meta={meta} mapsUri={subAccount.googleListing?.mapsUri} onSettled={settle} />
      {meta && <div className="mt-3 flex flex-wrap gap-2">{revoke}</div>}
    </Card>
  );
}

function WidgetForm({ api, meta, mapsUri, onSettled }: { api: string; meta: GbpWidgetMeta | null; mapsUri: string | null | undefined; onSettled: (meta: GbpWidgetMeta) => void }) {
  const [enabled, setEnabled] = useState(meta?.enabled ?? true);
  const [origins, setOrigins] = useState((meta?.allowedOrigins ?? []).join("\n"));
  const [maxReviews, setMaxReviews] = useState(String(meta?.maxReviews ?? 12));
  const [layout, setLayout] = useState(widgetDisplay(meta).layout);
  const [theme, setTheme] = useState(widgetDisplay(meta).theme);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    const allowedOrigins = origins.split("\n").map((o) => o.trim()).filter(Boolean);
    const { ok, data } = await call(api, "PUT", { enabled, allowedOrigins, maxReviews: Number(maxReviews), layout, theme });
    setBusy(false);
    if (ok && data.widget) {
      setOrigins(data.widget.allowedOrigins.join("\n"));
      setErrors([]);
      onSettled(data.widget);
      toast.success("Widget saved.");
      return;
    }
    setErrors(data.details?.length ? data.details.map((d) => `${d.value} — ${REASONS[d.reason] ?? d.reason}`) : [data.error ?? "That didn't work. Please try again."]);
  };

  const snippet = meta ? snippetFor(meta.publicId, mapsUri) : "";
  return (
    <div className="space-y-3">
      {!meta && <p className="text-sm text-muted-foreground" data-testid="gbp-widget-state-none">No widget yet — save to create one.</p>}
      {meta && !meta.enabled && (
        <p className="text-sm text-amber-700 dark:text-amber-400" data-testid="gbp-widget-state-disabled">
          Switched off: the feed answers “not found” and sites show their static content.
        </p>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} data-testid="gbp-widget-enable" />
        Enabled
      </label>
      <div className="space-y-1">
        <Label htmlFor="gbp-widget-origins">Allowed websites (one per line, e.g. https://www.example.com)</Label>
        <Textarea id="gbp-widget-origins" value={origins} onChange={(e) => setOrigins(e.target.value)} rows={3} data-testid="gbp-widget-origins" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="gbp-widget-max">Reviews shown (1–50)</Label>
        <Input id="gbp-widget-max" type="number" min={1} max={50} value={maxReviews} onChange={(e) => setMaxReviews(e.target.value)} className="w-24" />
      </div>
      <div className="flex flex-wrap gap-4">
        <div className="space-y-1">
          <Label htmlFor="gbp-widget-layout">Layout</Label>
          <select id="gbp-widget-layout" className={`${field} block`} value={layout} onChange={(e) => setLayout(e.target.value as GbpWidgetLayout)} data-testid="gbp-widget-layout">
            {LAYOUTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="gbp-widget-theme">Theme</Label>
          <select id="gbp-widget-theme" className={`${field} block`} value={theme} onChange={(e) => setTheme(e.target.value as GbpWidgetTheme)} data-testid="gbp-widget-theme">
            {THEMES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
      </div>
      {errors.length > 0 && (
        <ul className="list-disc pl-5 text-sm text-destructive" data-testid="gbp-widget-errors">
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={save} disabled={busy} data-testid="gbp-widget-save">
          {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
          {meta ? "Save widget" : "Create widget"}
        </Button>
        {meta && (
          <InlineConfirm
            label="Rotate id"
            confirmLabel="Yes, rotate"
            prompt="Issue a new id? The current snippet stops working until the site is updated."
            onConfirm={async () => {
              const { ok, data } = await call(`${api}/rotate`, "POST");
              if (ok) {
                if (data.widget) onSettled(data.widget);
                toast.success("New widget id issued — update the snippet on your site.");
              } else toast.error(data.error ?? "That didn't work. Please try again.");
            }}
            testId="gbp-widget-rotate"
          />
        )}
      </div>
      {meta && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Embed snippet</p>
          <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs" data-testid="gbp-widget-snippet">{snippet}</pre>
          <Button type="button" size="sm" variant="outline" onClick={() =>
              void navigator.clipboard
                ?.writeText(snippet)
                .then(() => toast.success("Snippet copied."))
                .catch(() => toast.error("Copy failed — select the snippet and copy it by hand."))
            }>
            Copy snippet
          </Button>
          <p className="text-xs text-muted-foreground">
            Feed URL: <code data-testid="gbp-widget-feed-url">{`${appUrl()}/api/public/gbp/feed/${meta.publicId}`}</code>
          </p>
        </div>
      )}
      {meta && <WidgetPreview publicId={meta.publicId} version={previewVersion(meta)} />}
    </div>
  );
}
