"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DonutChart } from "@/components/reports/charts";
import { Card } from "./overview-tiles";
import type { OverviewResponse } from "./types";

/**
 * The Overview's sentiment card (SP5 b): current labels over the reviews in
 * range, as a donut, plus what is not analysed yet and what couldn't be.
 * Admins can "Analyse now": the route answers 202 and classifies after the
 * response, so the card re-reads the overview every 3 s (for up to a minute)
 * until the run is over, then says what it did. Counts come from the API.
 */

export const POLL_MS = 3000;
export const MAX_POLLS = 20;

const SLICES = [
  { key: "positive", label: "Positive", color: "#10b981" },
  { key: "neutral", label: "Neutral", color: "#94a3b8" },
  { key: "negative", label: "Negative", color: "#ef4444" },
] as const;

interface Props {
  subAccountId: string;
  isAdmin: boolean;
  reviewsAi: OverviewResponse["reviewsAi"];
  sentiment: { positive: number; neutral: number; negative: number; notAnalysed: number; failed: number };
  /** Re-read the overview (the card's props update with the new counts). */
  onAnalysed: () => void;
}

function Muted({ testId, children }: { testId: string; children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground" data-testid={testId}>{children}</p>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Why a run stopped or did not run — shown instead of counts that would read as success. */
export const STOP_MESSAGE: Record<string, string> = {
  gate_off: "Reviews AI was switched off — nothing more was analysed.",
  google_gate_off: "Google reviews were switched off — nothing more was analysed.",
  no_listing: "No Google listing is selected, so there are no reviews to analyse.",
  listing_changed: "The Google listing changed during the run — nothing more was analysed.",
  daily_cap: "Daily AI limit reached — continues tomorrow.",
  budget: "The time allowed for this run ran out — the rest continues on the next run.",
  save_failed: "A label could not be saved — try again later.",
  ai_error: "The AI provider failed — try again later.",
  error: "The analysis stopped on an error — try again later.",
};

function describeRun(r: NonNullable<OverviewResponse["reviewsAi"]["lastRun"]>): string {
  const stop = r.reason ? STOP_MESSAGE[r.reason] : undefined;
  if (stop && r.classified + r.skipped + r.failed === 0) return stop;
  const parts = [`Labelled ${plural(r.classified, "review")}.`];
  if (r.skipped) parts.push(`${plural(r.skipped, "review")} left for the next run.`);
  if (r.failed) parts.push(`${plural(r.failed, "review")} could not be analysed this time.`);
  if (stop) parts.push(stop);
  return parts.join(" ");
}

/** Analyse now: POST, then poll the overview until the deferred run is over. */
function useAnalyse({ subAccountId, reviewsAi, onAnalysed }: Props) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  /** Bumped by each poll, so polling goes on even when a reload returns identical data. */
  const [tick, setTick] = useState(0);
  /** The lastRun.at seen before the press; the run is over when it changes and the lease is free. */
  const waiting = useRef<{ before: string | null; polls: number; note: string } | null>(null);

  useEffect(() => {
    const w = waiting.current;
    if (!w) return;
    const done = !reviewsAi.running && (reviewsAi.lastRun?.at ?? null) !== w.before;
    if (done && reviewsAi.lastRun) {
      waiting.current = null;
      setBusy(false);
      setResult(describeRun(reviewsAi.lastRun) + w.note);
      return;
    }
    if (w.polls >= MAX_POLLS) {
      waiting.current = null;
      setBusy(false);
      setResult("The result isn't in yet — reload later.");
      return;
    }
    const t = setTimeout(() => {
      w.polls += 1;
      setTick((n) => n + 1);
      onAnalysed();
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [reviewsAi.running, reviewsAi.lastRun, onAnalysed, busy, tick]);

  const analyse = async () => {
    setBusy(true);
    setResult(null);
    const res = await fetch(`/api/sub-accounts/${subAccountId}/reputation/sentiment/run`, { method: "POST" }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as { started?: boolean; aiConfigured?: boolean; error?: string } | null;
    if (res?.status !== 202 || !data?.started) {
      setBusy(false);
      // The route's own per-reason message (gate off, Google off, no listing, busy, too soon).
      setResult(data?.error ?? "Analysis could not be started. Please try again.");
      return;
    }
    const note = data.aiConfigured === false ? " AI isn't configured on this deployment — only star-only reviews can be labelled." : "";
    waiting.current = { before: reviewsAi.lastRun?.at ?? null, polls: 0, note };
    setTick((n) => n + 1); // start the polling effect
    onAnalysed();
  };
  return { busy, result, analyse };
}

export function SentimentCard(props: Props) {
  const { isAdmin, reviewsAi, sentiment } = props;
  const { busy, result, analyse } = useAnalyse(props);

  if (!reviewsAi.enabled) {
    return (
      <Card testId="rep-sentiment" title="Sentiment">
        <Muted testId="rep-sentiment-gate-off">Reviews AI is off for this sub-account — your agency can switch it on.</Muted>
      </Card>
    );
  }

  const analysed = sentiment.positive + sentiment.neutral + sentiment.negative;
  const total = analysed + sentiment.notAnalysed + sentiment.failed;

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
          None of the {total} review{total === 1 ? "" : "s"} in this range has been analysed yet.
          {reviewsAi.configured && " New and edited reviews are analysed after each sync."}
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
        </div>
      )}
      {sentiment.notAnalysed > 0 && analysed > 0 && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="rep-sentiment-not-analysed">
          {sentiment.notAnalysed} not analysed yet
        </p>
      )}
      {reviewsAi.lastRun?.reason === "ai_error" && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400" role="status" data-testid="rep-sentiment-ai-error">
          The AI provider failed on the last run — check the agency&apos;s OpenRouter key/credits.
        </p>
      )}
      {sentiment.failed > 0 && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="rep-sentiment-failed">
          {sentiment.failed} couldn&apos;t be analysed (the AI answered badly three times; tried again only if the review is edited)
        </p>
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
