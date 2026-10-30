"use client";

import { useEffect, useState } from "react";
import { Bot, Loader2, Sparkles } from "lucide-react";

interface AiConfig {
  configured: boolean;
  model: string;
  isOverride: boolean;
}

/** A green/grey status pill. */
function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium " +
        (ok
          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "bg-muted text-muted-foreground")
      }
    >
      <span
        className={
          "inline-block h-1.5 w-1.5 rounded-full " +
          (ok ? "bg-emerald-500" : "bg-muted-foreground/50")
        }
      />
      {label}
    </span>
  );
}

/** One label/value row. */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate font-mono text-xs">{value}</span>
    </div>
  );
}

/**
 * Read-only view of the deployment-wide AI model powering AI Agents. Set via
 * env vars (OPENROUTER_API_KEY + optional AI_REPLIES_DEFAULT_MODEL) — surfaced
 * here so the agency owner can see what's live at a glance.
 */
export function AiModelSection() {
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/agency/ai-config");
        if (!res.ok) throw new Error();
        const d = (await res.json()) as AiConfig;
        if (alive) setConfig(d);
      } catch {
        if (alive) setError(true);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section className="space-y-4 rounded-2xl border bg-card p-5">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
          <Sparkles className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold">AI model</h2>
          <p className="text-xs text-muted-foreground">
            The default model powering AI Agents across every channel. Set via
            environment variables — read-only here.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-6 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : error || !config ? (
        <p className="text-xs text-muted-foreground">
          Couldn&rsquo;t load AI configuration.
        </p>
      ) : (
        <div className="rounded-xl border bg-background p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-medium">
              <Bot className="h-4 w-4 text-muted-foreground" />
              OpenRouter
            </span>
            <StatusPill
              ok={config.configured}
              label={config.configured ? "Configured" : "Not configured"}
            />
          </div>
          <div className="divide-y">
            <Field label="Default model" value={config.model} />
            <Field
              label="Source"
              value={
                config.isOverride
                  ? "AI_REPLIES_DEFAULT_MODEL"
                  : "Built-in default"
              }
            />
          </div>
          {!config.configured && (
            <p className="mt-3 border-t pt-3 text-[11px] text-muted-foreground">
              Add <code>OPENROUTER_API_KEY</code> to switch AI Agents on. Until
              then this model isn&rsquo;t used and every channel stays silent.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
