"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import { useAgency } from "@/hooks/use-agency";

/**
 * Agency Settings card: master switch for the Agency Assistant (the
 * owner-level AI at /agency/ai-suite). OFF by default — every reply spends
 * the deployment's OpenRouter credits, so the owner opts in deliberately.
 * The per-sub-account Workspace Assistant is gated separately (per client,
 * from the Manage dialog) and is unaffected by this switch.
 *
 * Writes `agencyAssistantEnabled` via PATCH /api/agency; the sidebar entry
 * and the assistant page react live through the useAgency() snapshot.
 */
export function AgencyAssistantSection() {
  const agency = useAgency();
  const [saving, setSaving] = useState(false);
  // Optimistic local override while the PATCH is in flight; null = follow
  // the live doc.
  const [pending, setPending] = useState<boolean | null>(null);
  const [pendingModel, setPendingModel] = useState<"opus" | "sonnet" | null>(
    null,
  );

  const enabled = pending ?? agency.agencyAssistantEnabled;
  const model = pendingModel ?? agency.agencyAssistantModel;

  async function handleToggle(next: boolean) {
    setPending(next);
    setSaving(true);
    try {
      const res = await fetch("/api/agency", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agencyAssistantEnabled: next }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) throw new Error(payload.error ?? "Could not save.");
      toast.success(
        next
          ? "Agency Assistant enabled — it now appears in your sidebar."
          : "Agency Assistant disabled.",
      );
    } catch (err) {
      setPending(null);
      toast.error(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
      // Let the live snapshot take over once it reflects the new value.
      setTimeout(() => setPending(null), 2000);
    }
  }

  async function handleModelChange(next: "opus" | "sonnet") {
    setPendingModel(next);
    setSaving(true);
    try {
      const res = await fetch("/api/agency", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agencyAssistantModel: next }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) throw new Error(payload.error ?? "Could not save.");
      toast.success(
        next === "opus"
          ? "Agency Assistant model set to Opus (default — most reliable)."
          : "Agency Assistant model set to Sonnet (lower cost).",
      );
    } catch (err) {
      setPendingModel(null);
      toast.error(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
      // Let the live snapshot take over once it reflects the new value.
      setTimeout(() => setPendingModel(null), 2000);
    }
  }

  return (
    <section className="space-y-4 rounded-2xl border bg-card p-5">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
          <Sparkles className="h-4 w-4" />
        </span>
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            Agency Assistant
            <span className="rounded-full bg-fuchsia-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-fuchsia-600 dark:text-fuchsia-400">
              Beta
            </span>
          </h2>
          <p className="text-xs text-muted-foreground">
            Your owner-level AI: answers questions about running the agency
            and performs a few confirm-first actions (create sub-accounts,
            flip feature gates, act inside a client workspace).
          </p>
        </div>
      </div>

      <div className="flex items-start justify-between gap-3 rounded-xl border bg-background p-4">
        <div>
          <p className="text-xs font-medium">Enable the Agency Assistant</p>
          <p className="text-[11px] text-muted-foreground">
            Off by default. Every reply uses your OpenRouter credits
            (<code>OPENROUTER_API_KEY</code>). When off, the sidebar entry is
            hidden and the assistant refuses requests. Each client&apos;s{" "}
            <span className="font-medium">Workspace Assistant</span> is
            separate — enable it per sub-account under{" "}
            <Link
              href="/agency/sub-accounts"
              className="underline underline-offset-2"
            >
              Sub-accounts → Manage
            </Link>
            .
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={saving || agency.loading}
          onClick={() => handleToggle(!enabled)}
          className={
            "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 " +
            (enabled ? "bg-emerald-500" : "bg-muted-foreground/30")
          }
        >
          <span
            className={
              "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform " +
              (enabled ? "translate-x-4" : "translate-x-0.5")
            }
          />
        </button>
      </div>

      {enabled && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-background p-4">
          <div>
            <p className="text-xs font-medium">AI model</p>
            <p className="text-[11px] text-muted-foreground">
              Opus is the most reliable at complex multi-step actions; Sonnet
              costs roughly half per reply but can be less sure-footed.
            </p>
          </div>
          <select
            value={model}
            onChange={(e) =>
              handleModelChange(e.target.value as "opus" | "sonnet")
            }
            disabled={saving || agency.loading}
            className="h-8 shrink-0 rounded-md border border-input bg-background px-2 text-xs disabled:opacity-50 [&_option]:bg-background [&_option]:text-foreground"
            aria-label="Agency Assistant model"
          >
            <option value="opus">Opus — default (most reliable)</option>
            <option value="sonnet">Sonnet — lower cost</option>
          </select>
        </div>
      )}
    </section>
  );
}
