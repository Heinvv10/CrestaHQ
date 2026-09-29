import { Badge } from "@/components/ui/badge";
import { ScoreRing, StatusPill } from "@/components/prospecting/score-ring";
import { aiQuestions } from "@/lib/prospecting/report-story";
import {
  DETAIL_LABELS,
  LINK_KEYS,
  STATUS_NOTE,
  detailText,
  sectionRows,
  type SectionRow,
} from "@/lib/prospecting/report-rows";
import type { PublicReportSection, Scalar } from "@/lib/prospecting/public-sections";
import type { ProspectSectionKey } from "@/types";

/**
 * The section rows of a prospect report, shared by the public page
 * (`/report/[token]`) and the member view. Renders only the whitelisted
 * `PublicReportSection` shape. No hooks — safe in a server component.
 */

function DetailValue({ name, section, value }: { name: string; section: ProspectSectionKey; value: Scalar }) {
  const text = detailText(name, section, value);
  if (value === "notMeasured") return <span className="text-muted-foreground">{text}</span>;
  if (LINK_KEYS.has(name) && typeof value === "string" && /^https:\/\//i.test(value)) {
    return (
      <a href={value} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
        {text}
      </a>
    );
  }
  return <>{text}</>;
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
 *
 * `rows` (public page): the cards already computed by `reportStory`, so the
 * page lists exactly what the PDF lists.
 */
export function ReportSections(
  props: { connectHref?: string } & (
    | { rows: SectionRow[] }
    | { sections: PublicReportSection[]; showAll?: boolean; hideEmpty?: boolean }
  ),
) {
  const { connectHref } = props;
  const rows =
    "rows" in props
      ? props.rows
      : sectionRows(props.sections, { showAll: props.showAll, hideEmpty: props.hideEmpty });
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
