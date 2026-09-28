import { Badge } from "@/components/ui/badge";
import { ScoreRing, StatusPill } from "@/components/prospecting/score-ring";
import { aiQuestions } from "@/lib/prospecting/report-story";
import type { PublicReportSection, Scalar } from "@/lib/prospecting/public-sections";
import type { ProspectSectionKey } from "@/types";

/**
 * The section rows of a prospect report, shared by the public page
 * (`/report/[token]`) and the member view. Renders only the whitelisted
 * `PublicReportSection` shape. No hooks — safe in a server component.
 */

export const LABELS: Record<ProspectSectionKey, string> = {
  business_details: "Business details",
  gbp: "Google Business Profile",
  reputation: "Reviews & reputation",
  listings: "Directory listings",
  website_performance: "Website speed",
  tech_stack: "Website technology",
  ai_readiness: "AI readiness",
  ai_presence: "AI search presence",
  ads: "Advertising",
  lead_capture: "Lead capture",
};

const STATUS_NOTE: Record<Exclude<PublicReportSection["status"], "ok">, string> = {
  unavailable: "Could not be measured",
  timeout: "Timed out",
  failed: "Check failed",
};

/** Human labels for `details` keys. Listing keys are directory names and label themselves. */
const DETAIL_LABELS: Record<string, string> = {
  name: "Business name",
  website: "Website",
  category: "Category",
  https: "Website on HTTPS",
  description: "Business description",
  hoursListed: "Opening hours listed",
  photoCount: "Photos found",
  phoneListed: "Phone number listed",
  rating: "Google rating",
  reviewsCount: "Google reviews",
  velocity90d: "New reviews (last 90 days)",
  ownerReplyRate: "Owner reply rate",
  technologies: "Detected",
  metaAdLibraryUrl: "Meta Ad Library",
  googleAdsTransparencyUrl: "Google Ads Transparency Center",
  whatsapp: "WhatsApp click-to-chat",
  booking: "Online booking",
  contactForm: "Contact form",
  phoneLink: "Tap-to-call link",
  chatWidget: "Live chat",
  lcpSeconds: "Main content shown on a phone (s)",
  fcpSeconds: "First content shown (s)",
  speedIndexSeconds: "Speed index (s)",
  tbtMs: "Blocking time (ms)",
  cls: "Layout shift",
  mobileViewport: "Mobile-friendly layout",
  GPTBot: "ChatGPT crawler (GPTBot)",
  ClaudeBot: "Claude crawler (ClaudeBot)",
  PerplexityBot: "Perplexity crawler",
  "Google-Extended": "Google AI (Google-Extended)",
  robotsTxt: "robots.txt",
  localBusinessSchema: "LocalBusiness structured data",
  mentionedIn: "AI answers naming the business",
  answersMeasured: "AI answers checked",
  models: "AI models asked",
  topCompetitors: "Businesses named instead",
};

/** Only these details render as links; any other text stays text. */
const LINK_KEYS = new Set(["website", "metaAdLibraryUrl", "googleAdsTransparencyUrl"]);

const WORD_VALUE: Record<string, string> = {
  allowed: "Allowed",
  blocked: "Blocked",
  found: "Found",
  missing: "Missing",
};

const LISTING_STATUS: Record<string, string> = {
  found: "Listed",
  not_found: "No match",
  unknown: "Could not check",
};

function DetailValue({ name, section, value }: { name: string; section: ProspectSectionKey; value: Scalar }) {
  if (typeof value === "boolean") return <>{value ? "Yes" : "No"}</>;
  if (value === "notMeasured") return <span className="text-muted-foreground">Not measured</span>;
  if (section === "listings" && typeof value === "string") return <>{LISTING_STATUS[value] ?? value}</>;
  if (section === "ai_readiness" && typeof value === "string") return <>{WORD_VALUE[value] ?? value}</>;
  if (LINK_KEYS.has(name) && typeof value === "string" && /^https:\/\//i.test(value)) {
    return (
      <a href={value} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
        {name === "website" ? value : "Check manually"}
      </a>
    );
  }
  return <>{String(value)}</>;
}

/** Raw metrics: member view only, behind the "show everything" toggle (SOW, section cards). */
const RAW_METRIC_KEYS = new Set(["fcpSeconds", "speedIndexSeconds", "tbtMs", "cls"]);

/** Manual-check links: members only (C6). */
const MANUAL_CHECK_KEYS = new Set(["metaAdLibraryUrl", "googleAdsTransparencyUrl"]);

/** AI presence details the card renders as sentences rather than rows. */
const AI_PRESENCE_KEYS = new Set(["mentionedIn", "answersMeasured", "topCompetitors"]);

const MAX_FACTS = 3;

/**
 * The rows a card lists. By default at most three plain-language facts: no
 * raw metrics, nothing unmeasured, no manual-check links, only directories
 * the business was found in. `showAll` (the member toggle) lists every row.
 */
function factsOf(s: PublicReportSection, showAll: boolean): [string, Scalar][] {
  // Questions and the AI presence counts render as sentences (AiPresenceBody), never as rows too.
  const rows = Object.entries(s.details).filter(
    ([k, v]) => v !== null && !/^question\d+$/.test(k) && !(s.key === "ai_presence" && AI_PRESENCE_KEYS.has(k)),
  );
  if (showAll) return rows;
  return rows
    .filter(
      ([k, v]) =>
        v !== "notMeasured" &&
        !RAW_METRIC_KEYS.has(k) &&
        !MANUAL_CHECK_KEYS.has(k) &&
        (s.key !== "listings" || v === "found"),
    )
    .slice(0, MAX_FACTS);
}

/** Worst score first; unscored and unmeasured sections after, in stored order. */
function checkUpOrder(sections: PublicReportSection[]): PublicReportSection[] {
  const scoreOf = (s: PublicReportSection) => (s.status === "ok" && s.score !== null ? s.score : 101);
  return sections.map((s, i) => ({ s, i })).sort((a, b) => scoreOf(a.s) - scoreOf(b.s) || a.i - b.i).map(({ s }) => s);
}

function AiPresenceBody({ s }: { s: PublicReportSection }) {
  const questions = aiQuestions(s);
  const { mentionedIn, answersMeasured, topCompetitors } = s.details;
  return (
    <>
      {typeof mentionedIn === "number" && typeof answersMeasured === "number" ? (
        <p>
          Named in {mentionedIn} of {answersMeasured} AI answers.
          {typeof topCompetitors === "string" ? (
            <>
              {" "}
              Named instead: <span className="font-medium text-foreground">{topCompetitors}</span>.
            </>
          ) : null}
        </p>
      ) : null}
      {questions.length > 0 ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Questions we asked</p>
          <ul className="mt-1 space-y-1">
            {questions.map((q, i) => (
              <li key={i} className="rounded-md bg-muted px-2.5 py-1.5 text-foreground">
                &ldquo;{q}&rdquo;
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

/**
 * The section rows of a prospect report ("the rest of your check-up"),
 * shared by the public page and the member view: a score ring in the
 * traffic-light colour, the finding sentences and at most three facts.
 *
 * `connectHref` (member view only): where a section left out for want of an
 * ApexGEO key links to connect one. `showAll` (member view only): list the
 * raw metrics and the rows the public page hides. `hideEmpty` (public page
 * only): drop a section that came back `ok` with no score, no findings and
 * no rows to show (e.g. listings when nothing was found) rather than
 * rendering a bare heading. A failed/timed-out/unavailable section still
 * renders its reason. The member view always shows both.
 */
export function ReportSections({
  sections,
  connectHref,
  showAll = false,
  hideEmpty = false,
}: {
  sections: PublicReportSection[];
  connectHref?: string;
  showAll?: boolean;
  hideEmpty?: boolean;
}) {
  const rows = checkUpOrder(sections)
    .map((s) => ({
      s,
      label: LABELS[s.key] ?? s.key,
      facts: factsOf(s, showAll),
      scored: s.status === "ok" && s.score !== null,
    }))
    .filter((r) => !hideEmpty || r.s.status !== "ok" || r.scored || r.s.findings.length > 0 || r.facts.length > 0);
  return (
    <ul className="divide-y border-y">
      {rows.map(({ s, label, facts, scored }) => {
        return (
          <li key={s.key} data-testid={`report-section-${s.key}`} className="flex gap-3 py-4">
            {scored ? (
              <ScoreRing score={s.score!} label={label} />
            ) : (
              <span aria-hidden="true" className="size-11 shrink-0 rounded-full border-4 border-dashed border-muted" />
            )}
            <div className="min-w-0 flex-1 space-y-2 text-sm">
              <div className="flex items-start justify-between gap-3">
                <h3 className="pt-0.5 font-medium">{label}</h3>
                {scored ? (
                  <StatusPill score={s.score!} />
                ) : s.status !== "ok" ? (
                  <Badge variant="outline">{STATUS_NOTE[s.status]}</Badge>
                ) : null}
              </div>
              {s.status !== "ok" && s.reason ? <p className="text-muted-foreground">{s.reason}</p> : null}
              {connectHref && s.reasonCode === "not_connected" ? (
                <a href={connectHref} className="inline-block text-sm underline underline-offset-2">
                  Connect ApexGEO
                </a>
              ) : null}
              {s.findings.length > 0 ? (
                <ul className="space-y-1 text-muted-foreground">
                  {s.findings.map((f) => (
                    <li key={f.code}>{f.text}</li>
                  ))}
                </ul>
              ) : scored ? (
                // An unscored section (listings; AI presence left open) found nothing to judge.
                <p className="text-muted-foreground">No issues found.</p>
              ) : null}
              {s.key === "ai_presence" ? <AiPresenceBody s={s} /> : null}
              {facts.length > 0 ? (
                <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-xs">
                  {facts.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-muted-foreground">{DETAIL_LABELS[k] ?? k}</dt>
                      <dd className="text-right">
                        <DetailValue name={k} section={s.key} value={v} />
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
