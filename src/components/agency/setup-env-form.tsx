"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  Clock,
  Circle,
  AlertTriangle,
  Loader2,
  KeyRound,
  RefreshCw,
  Copy,
  Sparkles,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// ── shared types (mirror the API responses) ──────────────────────────────────

type KeyState = "missing" | "pending" | "active";

interface StatusKey {
  name: string;
  level: "req" | "rec" | "opt";
  state: KeyState;
  valid: boolean | null;
}
interface StatusGroup {
  title: string;
  tier: string;
  off: string | null;
  keys: StatusKey[];
}
interface ConfigResp {
  vercelWired: boolean;
  isLocal: boolean;
  formEnabled: boolean;
}

// ── small UI atoms (kit has no Switch primitive) ─────────────────────────────

function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 " +
        (checked ? "bg-emerald-500" : "bg-muted-foreground/30")
      }
    >
      <span
        className={
          "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform " +
          (checked ? "translate-x-4" : "translate-x-0.5")
        }
      />
    </button>
  );
}

function StatePill({ k }: { k: StatusKey }) {
  if (k.state === "active" && k.valid === false) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
        <AlertTriangle className="h-3 w-3" /> Active · check value
      </span>
    );
  }
  if (k.state === "active") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" /> Active
      </span>
    );
  }
  if (k.state === "pending") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-600 dark:text-sky-400">
        <Clock className="h-3 w-3" /> Saved · redeploy
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      <Circle className="h-3 w-3" /> Not set
    </span>
  );
}

interface Bucket {
  total: number;
  active: number;
  pending: number;
}

/** At-a-glance "N/M" chip with a status dot, e.g. Core 7/7. */
function SummaryPill({
  label,
  bucket,
  kind,
}: {
  label: string;
  bucket: Bucket;
  kind: "core" | "optional";
}) {
  const { total, active, pending } = bucket;
  const complete = total > 0 && active === total;
  // Core wants attention when incomplete (the app may not boot); optional is a
  // fine steady state partly-filled, so its incomplete dot stays neutral-blue.
  const dot = complete
    ? "bg-emerald-500"
    : active === 0
      ? "bg-muted-foreground/40"
      : kind === "core"
        ? "bg-amber-500"
        : "bg-sky-500";
  return (
    <div className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1">
      <span className={"h-2 w-2 rounded-full " + dot} />
      <span className="text-xs font-medium">{label}</span>
      <span className="text-xs tabular-nums text-muted-foreground">
        {active}/{total}
      </span>
      {pending > 0 && (
        <span className="text-[10px] text-sky-600 dark:text-sky-400">
          +{pending} pending
        </span>
      )}
    </div>
  );
}

// Format one `KEY=value` line for a `.env` block (Vercel's bulk-import parses
// this same dotenv shape). Mirrors the server-side writer in
// `lib/setup/env-file.ts`: quote values containing whitespace or dotenv-special
// chars so they paste back intact.
function formatEnvLine(key: string, value: string): string {
  if (!/[\s#"'=]/.test(value) && value !== "") return `${key}=${value}`;
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${key}="${escaped}"`;
}

// ── main component ────────────────────────────────────────────────────────────

export function SetupEnvForm() {
  const [config, setConfig] = useState<ConfigResp | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [togglingEnable, setTogglingEnable] = useState(false);

  const [groups, setGroups] = useState<StatusGroup[] | null>(null);
  const [preflightKeys, setPreflightKeys] = useState<StatusKey[]>([]);
  const [storedKnown, setStoredKnown] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState(false);

  const [values, setValues] = useState<Record<string, string>>({});
  const [targetVercel, setTargetVercel] = useState(true);
  const [targetLocal, setTargetLocal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [redeploying, setRedeploying] = useState(false);
  const [pendingRedeploy, setPendingRedeploy] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [exportCopied, setExportCopied] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportStored, setExportStored] = useState<
    { key: string; line: string; value: string }[]
  >([]);
  const [exportError, setExportError] = useState<string | null>(null);
  const [guideKey, setGuideKey] = useState<string | null>(null);
  const [guideText, setGuideText] = useState("");
  const [guideLoading, setGuideLoading] = useState(false);
  const [guideError, setGuideError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const res = await fetch("/api/agency/setup/status");
      const d = (await res.json().catch(() => ({}))) as {
        groups?: StatusGroup[];
        preflight?: StatusKey[];
        storedKnown?: boolean;
        error?: string;
      };
      if (!res.ok) throw new Error(d.error ?? "Couldn't load status.");
      setGroups(d.groups ?? []);
      setPreflightKeys(d.preflight ?? []);
      setStoredKnown(d.storedKnown ?? true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't load status.");
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  // Fetch the real, unmasked local env values (owner + local dev only — the
  // server 403s otherwise). Powers both the "Copy for Vercel" block and the
  // hover-to-reveal on the status board.
  const loadStoredEnv = useCallback(async () => {
    setExportLoading(true);
    setExportError(null);
    try {
      const res = await fetch("/api/agency/setup/export");
      const d = (await res.json().catch(() => ({}))) as {
        stored?: { key: string; line: string; value: string }[];
        error?: string;
      };
      if (!res.ok) throw new Error(d.error ?? "Couldn't read local env.");
      setExportStored(d.stored ?? []);
    } catch (err) {
      setExportStored([]);
      setExportError(
        err instanceof Error ? err.message : "Couldn't read local env.",
      );
    } finally {
      setExportLoading(false);
    }
  }, []);

  // Load config, then status if the form is enabled.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/agency/setup/config");
        const d = (await res.json()) as ConfigResp;
        if (!alive) return;
        setConfig(d);
        // Vercel writes need BOTH the toggle and the creds; local writes don't.
        const vercelWritable = d.vercelWired && d.formEnabled;
        setTargetVercel(vercelWritable);
        setTargetLocal(d.isLocal && !vercelWritable);
        if (d.formEnabled || d.isLocal) await loadStatus();
        // Locally, prefetch the unmasked values for hover-to-reveal.
        if (d.isLocal) loadStoredEnv();
      } catch {
        if (alive) toast.error("Couldn't load setup configuration.");
      } finally {
        if (alive) setLoadingConfig(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [loadStatus, loadStoredEnv]);

  async function toggleEnabled(next: boolean) {
    setTogglingEnable(true);
    try {
      const res = await fetch("/api/agency/setup/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ formEnabled: next }),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "Couldn't update.");
      setConfig((c) => (c ? { ...c, formEnabled: next } : c));
      if (next) {
        setTargetVercel(true);
        await loadStatus();
        toast.success("Vercel writes enabled.");
      } else {
        setTargetVercel(false);
        // Local dev keeps the board (local .env.local writes don't need this).
        if (config?.isLocal) await loadStatus();
        else setGroups(null);
        toast.success("Vercel writes disabled.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update.");
    } finally {
      setTogglingEnable(false);
    }
  }

  function setValue(key: string, v: string) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  const filled = Object.entries(values)
    .map(([key, value]) => ({ key, value: value.trim() }))
    .filter((e) => e.value !== "");

  // The paste-for-Vercel block. Running locally, the owner can already read
  // `.env.local` off disk, so we fetch the real stored values (unmasked) and
  // overlay anything typed-but-not-yet-saved so the block always reflects the
  // owner's latest intent. Server guarantees this only returns values locally.
  const exportBlock = (() => {
    const storedKeys = new Set(exportStored.map((s) => s.key));
    const lines = exportStored.map(({ key, line }) => {
      const typed = values[key]?.trim();
      return typed ? formatEnvLine(key, typed) : line;
    });
    // Typed values for keys not present on disk yet → append in input order.
    for (const { key, value } of filled) {
      if (!storedKeys.has(key)) lines.push(formatEnvLine(key, value));
    }
    return lines.join("\n");
  })();

  // key → current value, for the hover-to-reveal (populated locally only).
  const storedValues = new Map(exportStored.map((s) => [s.key, s.value]));

  // Roll the status board up into Core (boot tier) vs Optional (feature) counts
  // so the owner gets a one-glance sense of how configured the deployment is.
  const keySummary = groups
    ? (() => {
        const bucket = (match: (t: string) => boolean): Bucket => {
          const b: Bucket = { total: 0, active: 0, pending: 0 };
          for (const g of groups) {
            if (!match(g.tier)) continue;
            for (const k of g.keys) {
              b.total++;
              if (k.state === "active") b.active++;
              else if (k.state === "pending") b.pending++;
            }
          }
          return b;
        };
        return {
          core: bucket((t) => t === "boot"),
          optional: bucket((t) => t !== "boot"),
        };
      })()
    : null;

  // The ✨ per-key guides run on the same OpenRouter key that powers AI Agents,
  // so they only light up once that key is live + well-formed.
  const aiEnabled = !!groups?.some((g) =>
    g.keys.some(
      (k) =>
        k.name === "OPENROUTER_API_KEY" &&
        k.state === "active" &&
        k.valid !== false,
    ),
  );

  // Only the OpenRouter API KEY is special — it powers AI Agents AND the ✨
  // per-key guides — so it's pulled out and pinned above the rest. The rest of
  // its group (e.g. the optional default-model override) stays in place below.
  const aiGroup = groups?.find((g) =>
    g.keys.some((k) => k.name === "OPENROUTER_API_KEY"),
  );
  const openRouterKey = aiGroup?.keys.find(
    (k) => k.name === "OPENROUTER_API_KEY",
  );
  const otherGroups = (groups ?? [])
    .map((g) =>
      g === aiGroup
        ? { ...g, keys: g.keys.filter((k) => k.name !== "OPENROUTER_API_KEY") }
        : g,
    )
    .filter((g) => g.keys.length > 0);

  async function openGuide(name: string) {
    setGuideKey(name);
    setGuideText("");
    setGuideError(null);
    setGuideLoading(true);
    try {
      const res = await fetch(
        `/api/agency/setup/guide?key=${encodeURIComponent(name)}`,
      );
      const d = (await res.json().catch(() => ({}))) as {
        guide?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(d.error ?? "Couldn't generate a guide.");
      setGuideText(d.guide ?? "");
    } catch (err) {
      setGuideError(
        err instanceof Error ? err.message : "Couldn't generate a guide.",
      );
    } finally {
      setGuideLoading(false);
    }
  }

  function renderKeyRow(k: StatusKey) {
    // Locally, the owner can already read .env.local, so reveal the live value
    // on hover for keys that have one.
    const revealValue =
      config?.isLocal && k.state === "active"
        ? storedValues.get(k.name)
        : undefined;
    return (
      <div
        key={k.name}
        className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div
          className={
            "group/reveal relative flex min-w-0 items-center gap-2" +
            (revealValue !== undefined ? " cursor-help" : "")
          }
        >
          <code className="truncate text-xs">{k.name}</code>
          <StatePill k={k} />
          {aiEnabled && (
            <button
              type="button"
              onClick={() => openGuide(k.name)}
              title="Where do I get this key? (AI)"
              className="shrink-0 text-muted-foreground/50 transition-colors hover:text-violet-500"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span className="sr-only">Where do I get {k.name}?</span>
            </button>
          )}
          {revealValue !== undefined && (
            <div className="invisible absolute left-0 top-full z-20 mt-1 w-max max-w-sm rounded-md border bg-background p-2 opacity-0 shadow-md ring-1 ring-foreground/10 transition-opacity group-hover/reveal:visible group-hover/reveal:opacity-100">
              <p className="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                Current value
              </p>
              <p className="max-h-40 max-w-[22rem] overflow-auto font-mono text-[11px] leading-relaxed break-all">
                {revealValue}
              </p>
            </div>
          )}
        </div>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={
            k.state === "active" ? "paste new value to replace" : "paste value"
          }
          value={values[k.name] ?? ""}
          onChange={(e) => setValue(k.name, e.target.value)}
          className={
            "w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-xs sm:w-64 " +
            (k.state === "active"
              ? ""
              : "placeholder:text-amber-600 dark:placeholder:text-amber-400")
          }
        />
      </div>
    );
  }

  async function openExport() {
    setShowExport(true);
    await loadStoredEnv();
  }

  async function copyEnvBlock() {
    if (!exportBlock) return;
    try {
      await navigator.clipboard.writeText(exportBlock);
      setExportCopied(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setExportCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy — select the text and copy manually.");
    }
  }

  async function save() {
    if (filled.length === 0) return;
    if (!targetVercel && !targetLocal) {
      toast.error("Select at least one write target.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/agency/setup/env", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vars: filled,
          targets: { vercel: targetVercel, local: targetLocal },
        }),
      });
      const d = (await res.json().catch(() => ({}))) as {
        error?: string;
        rejected?: { key: string; reason: string }[];
        needsRedeploy?: boolean;
      };
      if (res.status === 422 && d.rejected) {
        toast.error(
          `Rejected: ${d.rejected.map((r) => `${r.key} (${r.reason})`).join("; ")}`,
        );
        return;
      }
      if (!res.ok) throw new Error(d.error ?? "Write failed.");
      toast.success(
        `Saved ${filled.length} key${filled.length === 1 ? "" : "s"}.` +
          (d.needsRedeploy ? " Redeploy to activate." : ""),
      );
      setValues({});
      if (d.needsRedeploy) setPendingRedeploy(true);
      await loadStatus();
      // A local write changed .env.local — refresh the revealable values.
      if (config?.isLocal) loadStoredEnv();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Write failed.");
    } finally {
      setSaving(false);
    }
  }

  async function redeploy() {
    setRedeploying(true);
    try {
      const res = await fetch("/api/agency/setup/redeploy", { method: "POST" });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "Redeploy failed.");
      setPendingRedeploy(false);
      toast.success(
        "Redeploy triggered — new values go live in ~1–3 min. This page shows the old build until it finishes.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Redeploy failed.");
    } finally {
      setRedeploying(false);
    }
  }

  if (loadingConfig || !config) {
    return (
      <div className="flex justify-center py-10 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  const toggleDisabled =
    togglingEnable || (!config.vercelWired && !config.formEnabled);
  const vercelWritable = config.formEnabled && config.vercelWired;

  return (
    <div className="space-y-6">
      {/* Enable toggle */}
      <section className="space-y-4 rounded-2xl border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              Vercel writes (production)
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Turn on to let this form write API keys to Vercel and trigger a
              redeploy. Optional — you can always set env vars manually.
              {config.isLocal &&
                " Running locally, you can write to .env.local below without turning this on."}
            </p>
          </div>
          <Toggle
            checked={config.formEnabled}
            disabled={toggleDisabled}
            onChange={toggleEnabled}
          />
        </div>

        {!config.vercelWired && (
          <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <p className="font-medium">Vercel credentials not detected.</p>
            <p className="mt-0.5">
              Add <code>VERCEL_TOKEN</code>, <code>VERCEL_PROJECT_ID</code>, and{" "}
              <code>VERCEL_DEPLOY_HOOK_URL</code> in your Vercel project, then
              redeploy once so this deployment can read them.
              {config.isLocal &&
                " (Running locally, you can still write to .env.local below — no Vercel needed.)"}
            </p>
          </div>
        )}
      </section>

      {(config.formEnabled || config.isLocal) && (
        <>
          {/* Targets */}
          <section className="space-y-3 rounded-2xl border bg-card p-5">
            <h3 className="text-sm font-semibold">Where to write</h3>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={targetVercel}
                disabled={!vercelWritable}
                onChange={(e) => setTargetVercel(e.target.checked)}
              />
              <span>
                Vercel production
                {!vercelWritable && (
                  <span className="ml-1 text-xs text-muted-foreground">
                    {!config.vercelWired
                      ? "(unavailable — Vercel creds not present)"
                      : "(turn on Vercel writes above to enable)"}
                  </span>
                )}
              </span>
            </label>
            {config.isLocal && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={targetLocal}
                  onChange={(e) => setTargetLocal(e.target.checked)}
                />
                <span>
                  Local <code>.env.local</code>
                  <span className="ml-1 text-xs text-muted-foreground">
                    (restart <code>pnpm dev</code> to pick up)
                  </span>
                </span>
              </label>
            )}
          </section>

          {/* Status board + inputs */}
          <section className="space-y-4 rounded-2xl border bg-card p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">API keys</h3>
              <button
                type="button"
                onClick={loadStatus}
                disabled={loadingStatus}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                <RefreshCw
                  className={"h-3 w-3 " + (loadingStatus ? "animate-spin" : "")}
                />
                Refresh
              </button>
            </div>

            {keySummary && (
              <div className="flex flex-wrap gap-2">
                <SummaryPill
                  label="Core"
                  bucket={keySummary.core}
                  kind="core"
                />
                <SummaryPill
                  label="Optional"
                  bucket={keySummary.optional}
                  kind="optional"
                />
              </div>
            )}

            {!storedKnown && (
              <p className="rounded-lg bg-muted px-3 py-2 text-[11px] text-muted-foreground">
                Couldn&rsquo;t read the Vercel env list — &ldquo;Saved · redeploy&rdquo;
                states below are approximate (based on the running build only).
              </p>
            )}

            {loadingStatus || !groups ? (
              <div className="flex justify-center py-8 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : (
              <div className="space-y-5">
                {openRouterKey && (
                  <div className="space-y-2 rounded-2xl border border-violet-500/30 bg-violet-500/5 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Sparkles className="h-4 w-4 shrink-0 text-violet-500" />
                      <p className="text-xs font-semibold tracking-wide text-violet-600 uppercase dark:text-violet-300">
                        AI setup assistant
                      </p>
                      <span
                        className={
                          "rounded-full px-2 py-0.5 text-[10px] font-medium " +
                          (aiEnabled
                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                            : "bg-muted text-muted-foreground")
                        }
                      >
                        {aiEnabled ? "Enabled" : "Locked"}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {aiEnabled
                        ? "Your OpenRouter key is live — AI Agents can reply, and the ✨ next to any key gives a quick “where do I get this?” guide."
                        : "Add your OpenRouter API key to power AI Agents — and unlock ✨ “where do I get this?” guides on every key below."}
                    </p>
                    <div className="divide-y rounded-xl border bg-background">
                      {renderKeyRow(openRouterKey)}
                    </div>
                  </div>
                )}

                {otherGroups.map((g) => (
                  <div key={g.title} className="space-y-2">
                    <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                      {g.title}
                    </p>
                    <div className="divide-y rounded-xl border">
                      {g.keys.map(renderKeyRow)}
                    </div>
                  </div>
                ))}

                {/* Vercel prerequisites — presence only, never editable or shown.
                    Set manually in Vercel; the form can't write its own creds. */}
                {preflightKeys.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                      Vercel (setup form prerequisites) · read-only
                    </p>
                    <div className="divide-y rounded-xl border">
                      {preflightKeys.map((k) => (
                        <div
                          key={k.name}
                          className="flex items-center justify-between gap-2 p-3"
                        >
                          <code className="truncate text-xs">{k.name}</code>
                          <div className="flex shrink-0 items-center gap-2">
                            <StatePill k={k} />
                            {aiEnabled && (
                              <button
                                type="button"
                                onClick={() => openGuide(k.name)}
                                title="Where do I get this key? (AI)"
                                className="shrink-0 text-muted-foreground/50 transition-colors hover:text-violet-500"
                              >
                                <Sparkles className="h-3.5 w-3.5" />
                                <span className="sr-only">
                                  Where do I get {k.name}?
                                </span>
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Set these in Vercel to enable the write path — the form
                      can&rsquo;t set its own credentials, and their values are
                      never shown here.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-3 border-t pt-4">
              <button
                type="button"
                onClick={save}
                disabled={saving || filled.length === 0}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                Save {filled.length > 0 ? `${filled.length} ` : ""}
                key{filled.length === 1 ? "" : "s"}
              </button>

              {vercelWritable && (
                <button
                  type="button"
                  onClick={redeploy}
                  disabled={redeploying}
                  className={
                    "inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50 " +
                    (pendingRedeploy
                      ? "border-sky-500 text-sky-600 dark:text-sky-400"
                      : "")
                  }
                >
                  {redeploying ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Redeploy
                </button>
              )}

              {/* No Vercel creds on this deployment → offer a copy-paste block
                  of the locally-stored env so a local owner can move it into
                  Vercel by hand. Values are read from disk (local dev only). */}
              {config.isLocal && !config.vercelWired && (
                <button
                  type="button"
                  onClick={openExport}
                  className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50"
                >
                  <Copy className="h-4 w-4" />
                  Copy for Vercel
                </button>
              )}

              {pendingRedeploy && (
                <span className="text-xs text-sky-600 dark:text-sky-400">
                  Saved to Vercel — redeploy to activate.
                </span>
              )}
            </div>
          </section>
        </>
      )}

      {/* Copy-for-Vercel modal — the locally-stored env as a paste-ready .env
          block. Values are read from disk; only served in local dev. */}
      <Dialog open={showExport} onOpenChange={setShowExport}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Copy for Vercel</DialogTitle>
            <DialogDescription>
              Your local environment in <code>.env</code> format. In Vercel open
              Project → Settings → Environment Variables, click the key/value
              field, and paste — it bulk-imports every line at once. Click the
              block below to copy.
            </DialogDescription>
          </DialogHeader>

          {exportLoading ? (
            <div className="flex items-center justify-center gap-2 rounded-lg border bg-muted/40 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Reading local env…
            </div>
          ) : exportError ? (
            <div className="rounded-lg bg-amber-500/10 px-3 py-3 text-xs text-amber-700 dark:text-amber-400">
              {exportError}
            </div>
          ) : (
            <div
              role="button"
              tabIndex={0}
              onClick={copyEnvBlock}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  copyEnvBlock();
                }
              }}
              className="group relative cursor-pointer rounded-lg border bg-muted/40 p-3 pt-8 transition-colors hover:bg-muted/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                className={
                  "absolute right-2 top-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 " +
                  (exportCopied
                    ? "bg-emerald-500/10 text-emerald-600 ring-emerald-500/20 dark:text-emerald-400"
                    : "bg-background text-muted-foreground ring-border")
                }
              >
                {exportCopied ? (
                  <>
                    <CheckCircle2 className="h-3 w-3" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" /> Click to copy
                  </>
                )}
              </span>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed">
                {exportBlock || "No environment values set locally yet."}
              </pre>
            </div>
          )}

          <p className="text-[11px] text-muted-foreground">
            These are your real local values, shown unmasked so you can copy them —
            they&rsquo;re read from <code>.env.local</code> on your machine and are
            only ever exposed in local dev, never on a deployed instance. After
            pasting into Vercel, redeploy there so the new values take effect.
          </p>
        </DialogContent>
      </Dialog>

      {/* ✨ AI mini-guide: where to obtain the clicked key. */}
      <Dialog
        open={guideKey !== null}
        onOpenChange={(o) => {
          if (!o) setGuideKey(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-violet-500" />
              Where to get {guideKey ?? ""}
            </DialogTitle>
            <DialogDescription>
              AI-written from the LeadStack setup docs — quick orientation, not a
              substitute for the provider&rsquo;s own steps.
            </DialogDescription>
          </DialogHeader>

          {guideLoading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Writing a quick guide…
            </div>
          ) : guideError ? (
            <div className="rounded-lg bg-amber-500/10 px-3 py-3 text-xs text-amber-700 dark:text-amber-400">
              {guideError}
            </div>
          ) : (
            <p className="text-sm leading-relaxed whitespace-pre-wrap">
              {guideText}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
