"use client";

import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DonutChart } from "@/components/reports/charts";
import { Card } from "./overview-tiles";

/**
 * The Overview's sentiment card (SP5 b): cached labels over the reviews in
 * range, as a donut, plus what is not analysed yet. Admins can "Analyse
 * now" (the same classification every sync runs; nothing unchanged is
 * re-billed). The counts come from the overview API; nothing is computed here.
 */

const SLICES = [
  { key: "positive", label: "Positive", color: "#10b981" },
  { key: "neutral", label: "Neutral", color: "#94a3b8" },
  { key: "negative", label: "Negative", color: "#ef4444" },
] as const;

interface Props {
  subAccountId: string;
  isAdmin: boolean;
  reviewsAi: { enabled: boolean; configured: boolean };
  sentiment: { positive: number; neutral: number; negative: number; notAnalysed: number };
  onAnalysed: () => void;
}

function Muted({ testId, children }: { testId: string; children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground" data-testid={testId}>{children}</p>;
}

export function SentimentCard({ subAccountId, isAdmin, reviewsAi, sentiment, onAnalysed }: Props) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  if (!reviewsAi.enabled) {
    return (
      <Card testId="rep-sentiment" title="Sentiment">
        <Muted testId="rep-sentiment-gate-off">Reviews AI is off for this sub-account — your agency can switch it on.</Muted>
      </Card>
    );
  }

  const analysed = sentiment.positive + sentiment.neutral + sentiment.negative;
  const total = analysed + sentiment.notAnalysed;

  const analyse = async () => {
    setBusy(true);
    setResult(null);
    const res = await fetch(`/api/sub-accounts/${subAccountId}/reputation/sentiment/run`, { method: "POST" }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as
      | { outcome?: { status: string; classified: number; failed: number }; error?: string }
      | null;
    setBusy(false);
    if (!res?.ok || !data?.outcome) {
      setResult(data?.error ?? "Analysis could not be started. Please try again.");
      return;
    }
    const o = data.outcome;
    setResult(
      o.status !== "ran"
        ? "An analysis is already running — check back in a minute."
        : `Analysed ${o.classified} review${o.classified === 1 ? "" : "s"}.${o.failed ? ` ${o.failed} could not be analysed and will be retried.` : ""}`,
    );
    onAnalysed();
  };

  return (
    <Card testId="rep-sentiment" title="Sentiment">
      {!reviewsAi.configured && (
        <Muted testId="rep-sentiment-not-configured">
          AI isn&apos;t configured on this deployment, so only star-only reviews are labelled (from their stars).
        </Muted>
      )}
      {total === 0 ? (
        <Muted testId="rep-sentiment-empty">No reviews in this range.</Muted>
      ) : analysed === 0 ? (
        <Muted testId="rep-sentiment-none">
          None of the {total} review{total === 1 ? "" : "s"} in this range has been analysed yet. New reviews are analysed after each sync.
        </Muted>
      ) : (
        <div data-testid="rep-sentiment-donut">
          <DonutChart data={SLICES.map((s) => ({ label: s.label, value: sentiment[s.key], color: s.color }))} size={120} />
          <ul className="sr-only">
            {SLICES.map((s) => (
              <li key={s.key} data-testid={`rep-sentiment-${s.key}`} data-count={sentiment[s.key]}>
                {s.label}: {sentiment[s.key]}
              </li>
            ))}
          </ul>
          {sentiment.notAnalysed > 0 && (
            <p className="mt-2 text-xs text-muted-foreground" data-testid="rep-sentiment-not-analysed">
              {sentiment.notAnalysed} not analysed yet
            </p>
          )}
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Star-only reviews are labelled from their stars (4–5 positive, 3 neutral, 1–2 negative); reviews with text are
        labelled by AI once, and again only if they are edited.
      </p>
      {isAdmin && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button type="button" size="sm" variant="outline" onClick={analyse} disabled={busy} data-testid="rep-sentiment-analyse">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Analyse now
          </Button>
          {result && <p className="text-sm" role="status" data-testid="rep-sentiment-result">{result}</p>}
        </div>
      )}
    </Card>
  );
}
