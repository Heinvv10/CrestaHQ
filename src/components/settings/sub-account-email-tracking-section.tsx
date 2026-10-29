"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useSubAccount } from "@/context/sub-account-context";
import { Checkbox } from "@/components/ui/checkbox";

/**
 * Broadcast open and click tracking (W4 PR2) — both off by default. PATCHes
 * `emailTracking.opens` / `.clicks` on /api/agency/sub-accounts/[id]
 * (sub-account-admin gated); the live doc from the provider drives the
 * checkboxes. Admin-only card, like the suppression list beside it.
 */

type Kind = "opens" | "clicks";

export function SubAccountEmailTrackingSection() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const [busy, setBusy] = useState<Kind | null>(null);
  if (!isAdmin) return null;

  const on = (kind: Kind) => subAccount?.emailTracking?.[kind] === true;

  async function toggle(kind: Kind, value: boolean) {
    setBusy(kind);
    try {
      const res = await fetch(`/api/agency/sub-accounts/${subAccountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emailTracking: { [kind]: value } }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to save.");
      toast.success(
        `${kind === "opens" ? "Open" : "Click"} tracking ${value ? "on" : "off"} for new broadcasts.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setBusy(null);
    }
  }

  const row = (kind: Kind, title: string, detail: string) => (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border bg-background px-3 py-2">
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="text-muted-foreground block text-xs">{detail}</span>
      </span>
      <Checkbox
        aria-label={title}
        checked={on(kind)}
        disabled={busy !== null}
        onCheckedChange={(v) => void toggle(kind, v === true)}
      />
    </label>
  );

  return (
    <section className="bg-card rounded-2xl border p-6">
      <h2 className="text-base font-semibold">Broadcast open &amp; click tracking</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Off by default. Applies to broadcasts sent after you switch it on; switching it off stops
        recording for emails already sent.
      </p>
      <div className="mt-4 space-y-2">
        {row(
          "opens",
          "Track opens (estimate)",
          "Adds an invisible 1×1 image to each broadcast email. Opens are an estimate: Apple Mail and some security filters load images automatically, and many readers block them.",
        )}
        {row(
          "clicks",
          "Track link clicks",
          "Sends each link through this app first, so the click is recorded before the reader lands on the page. Unsubscribe, email and phone links are never changed.",
        )}
      </div>
      <p className="text-muted-foreground mt-3 text-xs">
        POPIA: opens and clicks are personal information about each recipient. Say in your privacy
        notice that you measure them, and switch tracking off if you have no lawful basis to.
      </p>
    </section>
  );
}
