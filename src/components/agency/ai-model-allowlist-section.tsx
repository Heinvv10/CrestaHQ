"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ListChecks, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface CatalogModel {
  id: string;
  name: string;
  promptPerM: number | null;
  completionPerM: number | null;
}

interface AllowlistData {
  defaultModel: string;
  catalog: CatalogModel[];
  fetchedAt: number | null;
  policy: {
    allowedModels: string[];
    maxPromptPerM: number | null;
    maxCompletionPerM: number | null;
  };
  saved: boolean;
}

const MAX_SHOWN = 100;

function fmt(n: number | null): string {
  return n === null ? "—" : `$${n}`;
}

/**
 * Agency owner picks which OpenRouter models sub-accounts may choose for AI
 * Agents channels, plus an optional price ceiling. The list is OpenRouter's
 * catalog, refreshed server-side at most daily.
 */
export function AiModelAllowlistSection() {
  const [data, setData] = useState<AllowlistData | null>(null);
  const [error, setError] = useState(false);
  const [allowed, setAllowed] = useState<Set<string>>(new Set());
  const [maxPrompt, setMaxPrompt] = useState("");
  const [maxCompletion, setMaxCompletion] = useState("");
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/agency/ai-models");
        if (!res.ok) throw new Error(`ai-models ${res.status}`);
        const d = (await res.json()) as AllowlistData;
        if (!alive) return;
        setData(d);
        setAllowed(new Set(d.policy.allowedModels));
        setMaxPrompt(d.policy.maxPromptPerM?.toString() ?? "");
        setMaxCompletion(d.policy.maxCompletionPerM?.toString() ?? "");
      } catch (err) {
        console.warn("[ai-model-allowlist] load failed", err);
        if (alive) setError(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const catalogIds = useMemo(
    () => new Set(data?.catalog.map((m) => m.id) ?? []),
    [data],
  );
  // Allowed ids OpenRouter no longer lists — shown so the owner sees them.
  const retired = [...allowed].filter(
    (id) => data && id !== data.defaultModel && !catalogIds.has(id),
  );
  const shown = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.catalog
      .filter(
        (m) =>
          !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
      )
      .sort((a, b) => Number(allowed.has(b.id)) - Number(allowed.has(a.id)))
      .slice(0, MAX_SHOWN);
  }, [data, query, allowed]);

  function toggle(id: string, on: boolean) {
    setAllowed((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/agency/ai-models", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          allowedModels: [...allowed].filter((id) => catalogIds.has(id)),
          maxPromptPerM: maxPrompt.trim() === "" ? null : Number(maxPrompt),
          maxCompletionPerM:
            maxCompletion.trim() === "" ? null : Number(maxCompletion),
        }),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "Save failed");
      setData((prev) => (prev ? { ...prev, saved: true } : prev));
      toast.success("Allowed models saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-4 rounded-2xl border bg-card p-5">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
          <ListChecks className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold">Allowed AI models</h2>
          <p className="text-xs text-muted-foreground">
            Which models sub-accounts may pick for AI Agents. A channel whose
            model is retired or no longer allowed replies with the default.
          </p>
        </div>
      </div>

      {error ? (
        <p className="text-xs text-muted-foreground">
          Couldn&rsquo;t load the model list.
        </p>
      ) : !data ? (
        <div className="flex justify-center py-6 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : (
        <div className="space-y-4">
          {!data.saved && (
            <p className="rounded-lg border bg-muted/30 p-3 text-[11px] text-muted-foreground">
              Not saved yet: every model already in use stays allowed. The
              ticks below are that starting point plus the default.
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ai-max-prompt">Max input price (USD / 1M tokens)</Label>
              <Input
                id="ai-max-prompt"
                type="number"
                min={0}
                step="any"
                value={maxPrompt}
                onChange={(e) => setMaxPrompt(e.target.value)}
                placeholder="No ceiling"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ai-max-completion">Max output price (USD / 1M tokens)</Label>
              <Input
                id="ai-max-completion"
                type="number"
                min={0}
                step="any"
                value={maxCompletion}
                onChange={(e) => setMaxCompletion(e.target.value)}
                placeholder="No ceiling"
              />
            </div>
          </div>

          {retired.length > 0 && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              No longer offered by OpenRouter (dropped on save):{" "}
              {retired.join(", ")}
            </p>
          )}

          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${data.catalog.length} models…`}
          />
          <div className="max-h-80 divide-y overflow-y-auto rounded-xl border bg-background">
            {shown.map((m) => {
              const isDefault = m.id === data.defaultModel;
              return (
                <label
                  key={m.id}
                  className="flex items-center gap-3 px-3 py-2 text-xs"
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5"
                    checked={isDefault || allowed.has(m.id)}
                    disabled={isDefault}
                    onChange={(e) => toggle(m.id, e.target.checked)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{m.name}</span>
                    <span className="block truncate font-mono text-muted-foreground">
                      {m.id}
                      {isDefault && " · default, always allowed"}
                    </span>
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {m.promptPerM === null || m.completionPerM === null
                      ? "price unknown"
                      : `${fmt(m.promptPerM)} / ${fmt(m.completionPerM)}`}
                  </span>
                </label>
              );
            })}
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-muted-foreground">
              Prices in / out per 1M tokens. The ceiling can&rsquo;t check a
              model with an unknown price — it is allowed only if ticked.{" "}
              {data.fetchedAt
                ? `List updated ${new Date(data.fetchedAt).toLocaleString()}.`
                : "OpenRouter's list hasn't loaded yet."}
            </p>
            <Button size="sm" onClick={save} disabled={saving || !data.fetchedAt}>
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
