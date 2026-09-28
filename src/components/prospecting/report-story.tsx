import { MessageCircle } from "lucide-react";
import { ScoreRing } from "@/components/prospecting/score-ring";
import { LABELS } from "@/components/prospecting/report-view";
import type { PublicReportSection } from "@/lib/prospecting/public-sections";
import type { AiHook, RankedFinding } from "@/lib/prospecting/report-story";

/**
 * The blocks of the public report page (direction C "Story", picked by Hein
 * 2026-09-28): the dark hero, the desktop ring grid, the Top 3 and the call
 * to action. Server components, no hooks: the page is a server component and
 * a client import crashed it once (#293). Brand-coloured parts read the
 * `--report-brand` variable the page sets; the traffic-light colours live in
 * `ScoreRing` and never read it.
 */

const BRAND_BG = "bg-[var(--report-brand)] text-white";

/** "4 of 9 areas need work" — a count, never a grade. */
function AreaCount({ needWork, scored }: { needWork: number; scored: number }) {
  if (scored === 0 || needWork === 0) return null;
  return (
    <p data-testid="area-count" className="mt-6 inline-flex items-baseline gap-2 rounded-lg bg-white/10 px-3 py-2 text-sm">
      <span className="text-2xl font-semibold tabular-nums">
        {needWork} of {scored}
      </span>
      areas need work
    </p>
  );
}

export function ReportHero({
  businessName,
  headline,
  finding,
  hook,
  area,
}: {
  businessName: string | null;
  /** The stored headline, so the page says what the outreach message said. */
  headline: string | null;
  finding: RankedFinding | null;
  hook: AiHook | null;
  area: { needWork: number; scored: number };
}) {
  const noFindings = !finding;
  return (
    <section data-testid={hook ? "hero-ai" : "hero-headline"} className="bg-[#111827] text-white">
      <div className="mx-auto w-full max-w-3xl px-4 py-10 md:py-14">
        {hook ? (
          <>
            <p className="text-xs font-medium uppercase tracking-wider text-gray-300">
              We asked AI assistants like ChatGPT and Gemini
            </p>
            <div className="mt-4 flex flex-col gap-3">
              <p className={`${BRAND_BG} max-w-[85%] self-end rounded-2xl rounded-br-sm px-4 py-2.5 text-sm`}>
                {hook.question}
              </p>
              {hook.competitors ? (
                <p className="max-w-[85%] self-start rounded-2xl rounded-bl-sm bg-white/10 px-4 py-2.5 text-sm text-gray-100">
                  They named: <span className="font-semibold text-white">{hook.competitors}</span>
                </p>
              ) : null}
            </div>
            <h1 className="mt-8 font-serif text-4xl leading-tight md:text-5xl">
              {businessName ?? "Your business"}{" "}
              {hook.mentioned === 0
                ? "wasn’t mentioned."
                : `was named in ${hook.mentioned} of ${hook.measured} answers.`}
            </h1>
            <p className="mt-3 text-gray-300">
              We asked {hook.measured} times.{" "}
              {hook.mentioned === 0 ? "None of the answers named you." : `Only ${hook.mentioned} named you.`}
              {finding?.impact ? ` ${finding.impact}` : ""}
            </p>
            <ul aria-label={`${hook.mentioned} of ${hook.measured} AI answers named the business`} className="mt-5 flex flex-wrap gap-2">
              {Array.from({ length: hook.measured }, (_, i) => {
                const named = i < hook.mentioned;
                return (
                  <li
                    key={i}
                    aria-hidden="true"
                    className="flex size-6 items-center justify-center rounded-full text-xs font-bold text-white"
                    style={{ backgroundColor: named ? "#1E874B" : "#9F1D1D" }}
                  >
                    {named ? "✓" : "✕"}
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <>
            <p className="text-xs font-medium uppercase tracking-wider text-gray-300">
              Online presence report{businessName ? ` for ${businessName}` : ""}
            </p>
            <h1 className="mt-4 font-serif text-4xl leading-tight md:text-5xl">
              {noFindings ? "No major issues found" : (headline ?? finding.text)}
            </h1>
            {noFindings ? (
              area.scored > 0 ? (
                <p className="mt-3 text-gray-300">We checked {area.scored} areas and none of them needs work.</p>
              ) : null
            ) : finding.impact ? (
              <p className="mt-3 text-gray-300">{finding.impact}</p>
            ) : null}
          </>
        )}
        <AreaCount {...area} />
      </div>
    </section>
  );
}

/** Desktop only: one ring per scored public section (direction B's grid). */
export function RingGrid({ sections }: { sections: PublicReportSection[] }) {
  const scored = sections.filter((s) => s.status === "ok" && s.score !== null);
  if (scored.length === 0) return null;
  return (
    <ul data-testid="ring-grid" className="hidden grid-cols-4 gap-3 md:grid">
      {scored.map((s) => (
        <li key={s.key} className="flex flex-col items-center gap-2 rounded-xl border bg-card p-4 text-center">
          <ScoreRing score={s.score!} label={LABELS[s.key]} size={56} />
          <span className="text-sm font-medium">{LABELS[s.key]}</span>
        </li>
      ))}
    </ul>
  );
}

/** The three worst findings, each with its stored impact (none before R0). */
export function TopFixes({ findings }: { findings: RankedFinding[] }) {
  if (findings.length === 0) return null;
  return (
    <section data-testid="top-fixes">
      <h2 className="font-serif text-3xl">
        {findings.length === 3 ? "Three things to fix first" : "What to fix first"}
      </h2>
      <ol className="mt-4 space-y-4">
        {findings.map((f, i) => (
          <li key={`${f.section}-${f.code}`} className="flex gap-4">
            <span aria-hidden="true" className="w-6 shrink-0 font-serif text-3xl leading-none text-[var(--report-brand)]">
              {i + 1}
            </span>
            <div>
              <p className="font-medium">{f.text}</p>
              {f.impact ? <p className="mt-1 text-sm text-muted-foreground">{f.impact}</p> : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * The call to action tied to the headline: its stored `cta` line, else a
 * generic one. Each button shows only when it has somewhere to go.
 */
export function ReportCta({
  line,
  agencyName,
  bookHref,
  whatsappHref,
}: {
  line: string | null;
  agencyName: string | null;
  bookHref: string | null;
  whatsappHref: string | null;
}) {
  if (!bookHref && !whatsappHref) return null;
  return (
    <section data-testid="report-cta" className="rounded-2xl border-2 border-[var(--report-brand)] bg-card p-6">
      <h2 className="font-serif text-3xl leading-tight">{line ?? "Want help fixing these?"}</h2>
      {agencyName ? (
        <p className="mt-2 text-sm text-muted-foreground">{agencyName} can help fix the issues above.</p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-3">
        {/* Plain classes: buttonVariants lives in a "use client" module and
            cannot be called from this server component. */}
        {bookHref ? (
          <a
            href={bookHref}
            className={`${BRAND_BG} inline-flex h-11 items-center justify-center rounded-lg px-5 text-sm font-semibold outline-none hover:opacity-90 focus-visible:ring-3 focus-visible:ring-ring/50`}
          >
            Book a call
          </a>
        ) : null}
        {whatsappHref ? (
          <a
            href={whatsappHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border-2 border-foreground px-5 text-sm font-semibold outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <MessageCircle className="size-4" aria-hidden="true" />
            WhatsApp us
          </a>
        ) : null}
      </div>
    </section>
  );
}
