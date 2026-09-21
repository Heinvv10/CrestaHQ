import Link from "next/link";
import { CheckCircle2, Circle } from "lucide-react";
import { AreaChart, BarChart } from "@/components/reports/charts";
import { Card } from "./overview-tiles";
import { CHANNEL_LABEL, SOURCE_LABEL, fmtBucket, fmtDate, fmtHours, fmtPercent } from "./format";
import type { OverviewResponse } from "./types";

/** The Overview's response, requests and checklist cards. */

type Data = OverviewResponse;

export function ResponseCard({ data }: { data: Data }) {
  const r = data.reviews!.response;
  const replyTrend = data.trend.flatMap((b) =>
    b.avgReplyHours === null ? [] : [{ x: fmtBucket(b.start, data.range.bucket), y: +b.avgReplyHours.toFixed(1) }],
  );
  return (
    <Card testId="rep-response" title="Review response">
      <div className="flex flex-wrap gap-6 text-sm">
        <p data-testid="rep-response-replied"><span className="text-xl font-semibold">{r.replied}</span> replied</p>
        <p data-testid="rep-response-unreplied"><span className="text-xl font-semibold">{r.unreplied}</span> not replied</p>
        <p><span className="text-xl font-semibold">{fmtPercent(r.coverage)}</span> coverage</p>
      </div>
      <p className="mt-4 text-xs font-medium">Time to latest reply — Google reports only the latest reply time</p>
      <p className="text-xs text-muted-foreground">
        Average {fmtHours(r.replyHours.avg)} · median {fmtHours(r.replyHours.median)} over {r.replyHours.counted} replied
        review{r.replyHours.counted === 1 ? "" : "s"}. An edited reply moves this time.
        {r.replyHours.excluded > 0 && ` ${r.replyHours.excluded} left out (reply time missing or before the review).`}
      </p>
      <div className="mt-3">
        {replyTrend.length ? (
          <AreaChart data={replyTrend} tone="emerald" height={100} />
        ) : (
          <p className="text-sm text-muted-foreground">No replies in this range.</p>
        )}
      </div>
    </Card>
  );
}

export function RequestsCard({ data }: { data: Data }) {
  const { requests } = data;
  const x = (s: string) => fmtBucket(s, data.range.bucket);
  const channels = Object.entries(requests.byChannel);
  const sources = Object.entries(requests.bySource);
  return (
    <Card testId="rep-requests" title="Review requests">
      <p className="text-sm" data-testid="rep-requests-since">
        {requests.countingSince
          ? `Counting since ${fmtDate(requests.countingSince)} — the first logged request. Earlier requests were not logged.`
          : "No review requests have been logged yet."}
      </p>
      {channels.length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="rep-requests-channels">
          {channels.map(([c, n]) => `${CHANNEL_LABEL[c] ?? c}: ${n}`).join(" · ")}
        </p>
      )}
      {sources.length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="rep-requests-sources">
          {sources.map(([s, n]) => `${SOURCE_LABEL[s] ?? s}: ${n}`).join(" · ")}
        </p>
      )}
      {requests.tracked > 0 && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="rep-requests-clicked">
          Clicked: {requests.clicked} of {requests.tracked} tracked request{requests.tracked === 1 ? "" : "s"}. Links are tracked
          only in requests sent while reminders are on.
        </p>
      )}
      {requests.failed > 0 && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="rep-requests-failed">
          {requests.failed} more review ask{requests.failed === 1 ? "" : "s"} failed to send and {requests.failed === 1 ? "is" : "are"} not counted.
        </p>
      )}
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <div>
          <p className="mb-2 text-xs text-muted-foreground">Requests sent</p>
          <BarChart data={data.trend.map((b) => ({ x: x(b.start), y: b.requests }))} tone="violet" height={100} />
        </div>
        {data.reviews && (
          <div>
            <p className="mb-2 text-xs text-muted-foreground">Reviews gained</p>
            <BarChart data={data.trend.map((b) => ({ x: x(b.start), y: b.reviews ?? 0 }))} tone="amber" height={100} />
          </div>
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Shown side by side only: Google does not say which request led to which review, so they are not linked one-to-one.
      </p>
    </Card>
  );
}

const ITEMS: Array<{ key: keyof Data["checklist"]; label: string; href: (sa: string) => string }> = [
  { key: "googleConnected", label: "Connect Google Business Profile", href: (sa) => `/sa/${sa}/ai-agents/google-business` },
  { key: "listingSelected", label: "Choose your listing", href: (sa) => `/sa/${sa}/ai-agents/google-business` },
  { key: "reviewLinkConfigured", label: "Set your review link (Settings Sub-Account → Messaging tab)", href: (sa) => `/sa/${sa}/dashboard/settings` },
  { key: "widgetExists", label: "Create a reviews widget", href: (sa) => `/sa/${sa}/reputation/widgets` },
  { key: "requestLogged", label: "Send your first review request", href: (sa) => `/sa/${sa}/contacts` },
];

export function Checklist({ data, subAccountId }: { data: Data; subAccountId: string }) {
  const done = ITEMS.filter((i) => data.checklist[i.key]).length;
  return (
    <Card testId="rep-checklist" title={`Get set up — ${done} of ${ITEMS.length} done`}>
      <ul className="space-y-2 text-sm">
        {ITEMS.map((i) => {
          const ok = data.checklist[i.key];
          return (
            <li key={i.key} className="flex items-center gap-2" data-testid={`rep-checklist-${i.key}`} data-done={String(ok)}>
              {ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Circle className="h-4 w-4 text-muted-foreground" />}
              {ok ? <span>{i.label}</span> : <Link href={i.href(subAccountId)} className="underline-offset-2 hover:underline">{i.label}</Link>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
