"use client";

import { useEffect, useState } from "react";
import type { UsageQuotas } from "@/types/usage";

/**
 * Usage Metering v1 — tiny "Near/Over quota" badge for the Client billing
 * table. Fetches the workspace's usage once; renders NOTHING unless a
 * quota exists and the current month is past 80% of it, so the table
 * stays clean for unlimited workspaces. Best-effort: any fetch failure
 * renders nothing.
 */

const CHECKS: {
  used: string;
  quota: keyof UsageQuotas;
  factor: number;
}[] = [
  { used: "emailsSent", quota: "emailsPerMonth", factor: 1 },
  { used: "smsSegments", quota: "smsSegmentsPerMonth", factor: 1 },
  { used: "whatsappMessages", quota: "whatsappPerMonth", factor: 1 },
  { used: "aiTokens", quota: "aiTokensPerMonth", factor: 1 },
  { used: "voiceSeconds", quota: "voiceMinutesPerMonth", factor: 60 },
];

export function UsageQuotaBadge({ subAccountId }: { subAccountId: string }) {
  const [level, setLevel] = useState<"near" | "over" | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLevel(null);
    fetch(`/api/agency/sub-accounts/${subAccountId}/usage`)
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (d: {
          usage?: Record<string, number>[];
          quotas?: UsageQuotas | null;
        } | null) => {
          if (cancelled || !d?.quotas || !d.usage?.[0]) return;
          let maxPct = 0;
          for (const c of CHECKS) {
            const q = d.quotas[c.quota];
            if (typeof q !== "number" || q <= 0) continue;
            const used = d.usage[0][c.used] ?? 0;
            maxPct = Math.max(maxPct, (used / (q * c.factor)) * 100);
          }
          if (maxPct >= 100) setLevel("over");
          else if (maxPct >= 80) setLevel("near");
        },
      )
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [subAccountId]);

  if (!level) return null;
  return (
    <span
      className={
        level === "over"
          ? "rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700 ring-1 ring-rose-500/30 dark:text-rose-300"
          : "rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 ring-1 ring-amber-500/30 dark:text-amber-300"
      }
    >
      {level === "over" ? "Over quota" : "Near quota"}
    </span>
  );
}
