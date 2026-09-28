import type { ProspectFinding, ProspectSectionResult } from "@/types";
import type { ApexgeoEngineResult, ApexgeoScan } from "../apexgeo-client";
// Relative `.ts` imports: scripts/prospecting/backfill-r0b.ts imports this file.
import { isCompetitorName } from "./competitors.ts";
import { finding, scoreOf } from "./findings.ts";
import { measured, unavailable, type Scored } from "./types.ts";

/**
 * Section 8 — AI answer-engine presence, from the ApexGEO scan's
 * `ai_visibility` probe (decision D5):
 *
 *   - An engine answer with `error` set is NOT measured. It never counts as
 *     "not mentioned".
 *   - `not_in_ai_answers` fires only when every measured engine answered
 *     every prompt and none named the business. An engine that errored on
 *     some prompts leaves the question open: no finding, and no score.
 *   - `ai_mentions_partial` fires when some measured answers named it and
 *     some did not.
 *   - No engine answered at all → the section is unavailable.
 *
 * Kept for the report: the counts, the engines' models (member view only),
 * the three competitors named most often, and each question asked with the
 * competitors named in answer to it (public business names, filtered by
 * competitors.ts). The answers' text and `cited_url` are not kept. Finding
 * text never names a model id (C4).
 */

export const key = "ai_presence" as const;

interface Tally {
  measured: number;
  mentioned: number;
  /** Every answer from every engine that answered at least once was measured. */
  complete: boolean;
  models: string[];
  competitors: string[];
  /** Each question asked, with the competitors named in its measured answers. */
  prompts: { text: string; competitors: string[] }[];
  /** Names dropped by the competitor filter, for the log. */
  dropped: string[];
}

export function tally(visibility: ApexgeoScan["ai_visibility"], businessName: string | null = null): Tally {
  const answers = (visibility?.prompts ?? []).flatMap((p) => p.engines);
  const ok = (e: ApexgeoEngineResult) => e.error === null;
  const measuredEngines = new Set(answers.filter(ok).map((e) => e.key));
  const good = answers.filter(ok);
  const dropped = new Set<string>();
  const keep = (name: string) => {
    if (isCompetitorName(name, businessName)) return true;
    dropped.add(name);
    return false;
  };
  return {
    measured: good.length,
    mentioned: good.filter((e) => e.mentioned).length,
    complete: answers.filter((e) => measuredEngines.has(e.key)).every(ok),
    models: [...new Set(good.map((e) => e.model))],
    competitors: topCompetitors(good, keep, 3),
    prompts: (visibility?.prompts ?? []).map((p) => ({
      text: p.text,
      competitors: topCompetitors(p.engines.filter(ok), keep, Infinity),
    })),
    dropped: [...dropped],
  };
}

/** Names counted once per answer, case-insensitively; ties keep first-seen order. */
function topCompetitors(answers: ApexgeoEngineResult[], keep: (name: string) => boolean, n: number): string[] {
  const counts = new Map<string, { name: string; count: number; first: number }>();
  let seen = 0;
  for (const answer of answers) {
    const inAnswer = new Set<string>();
    for (const raw of answer.competitors_named) {
      const name = raw.trim();
      const id = name.toLowerCase();
      if (!name || inAnswer.has(id) || !keep(name)) continue;
      inAnswer.add(id);
      const c = counts.get(id);
      if (c) c.count++;
      else counts.set(id, { name, count: 1, first: seen++ });
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.first - b.first)
    .slice(0, n)
    .map((c) => c.name);
}

/** The `not_in_ai_answers` sentence. Also used by the R0b backfill to replace text naming model ids. */
export function notInAiAnswersText(measuredAnswers: number): string {
  return `AI assistants like ChatGPT and Gemini did not name the business in any of ${measuredAnswers} answers to local searches for its services.`;
}

/** The `ai_mentions_partial` sentence. Also used by the R0b backfill. */
export function aiMentionsPartialText(mentioned: number, measuredAnswers: number): string {
  return `AI assistants like ChatGPT and Gemini named the business in only ${mentioned} of ${measuredAnswers} answers to local searches for its services.`;
}

export function score(visibility: ApexgeoScan["ai_visibility"]): Scored | null {
  const t = tally(visibility);
  if (t.measured === 0) return null;
  const findings: ProspectFinding[] = [];
  if (t.mentioned === 0) {
    // Not named, but an engine left some prompts unanswered: nothing honest to deduct.
    if (!t.complete) return { score: null, findings };
    findings.push(finding("not_in_ai_answers", notInAiAnswersText(t.measured)));
  } else if (t.mentioned < t.measured) {
    findings.push(finding("ai_mentions_partial", aiMentionsPartialText(t.mentioned, t.measured)));
  }
  return { score: scoreOf(findings), findings };
}

export function result(scan: ApexgeoScan, businessName: string | null = null): ProspectSectionResult {
  const scored = score(scan.ai_visibility);
  if (!scored) return unavailable(key, "No AI assistant answered the test searches, so presence could not be measured.");
  const t = tally(scan.ai_visibility, businessName);
  if (t.dropped.length > 0) {
    console.warn("[prospecting/ai_presence] competitor names dropped", { dropped: t.dropped });
  }
  return measured(key, scored, {
    mentionedIn: t.mentioned,
    answersMeasured: t.measured,
    models: t.models.join(", "),
    topCompetitors: t.competitors.length > 0 ? t.competitors.join(", ") : null,
    prompts: t.prompts,
  });
}
