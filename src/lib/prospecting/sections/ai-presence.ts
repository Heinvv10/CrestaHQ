import type { ProspectFinding, ProspectSectionResult } from "@/types";
import type { ApexgeoEngineResult, ApexgeoScan } from "../apexgeo-client";
import { measured, unavailable, type Scored } from "./types";

/**
 * Section 8 — AI answer-engine presence, from the ApexGEO scan's
 * `ai_visibility` probe (decision D5):
 *
 *   - An engine answer with `error` set is NOT measured. It never counts as
 *     "not mentioned".
 *   - Share of voice = answers naming the business / measured answers.
 *   - `not_in_ai_answers` fires only when every measured engine answered
 *     every prompt and none named the business. An engine that errored on
 *     some prompts leaves the question open, so no finding.
 *   - No engine answered at all → the section is unavailable.
 *
 * Kept for the report: the counts, the engines' models, and the three
 * competitors named most often (public business names from the answers).
 * The answers' text and `cited_url` are not kept.
 */

export const key = "ai_presence" as const;

interface Tally {
  measured: number;
  mentioned: number;
  /** Every answer from every engine that answered at least once was measured. */
  complete: boolean;
  models: string[];
  competitors: string[];
}

export function tally(visibility: ApexgeoScan["ai_visibility"]): Tally {
  const answers = (visibility?.prompts ?? []).flatMap((p) => p.engines);
  const ok = (e: ApexgeoEngineResult) => e.error === null;
  const measuredEngines = new Set(answers.filter(ok).map((e) => e.key));
  const good = answers.filter(ok);
  return {
    measured: good.length,
    mentioned: good.filter((e) => e.mentioned).length,
    complete: answers.filter((e) => measuredEngines.has(e.key)).every(ok),
    models: [...new Set(good.map((e) => e.model))],
    competitors: topCompetitors(good, 3),
  };
}

/** Names counted once per answer, case-insensitively; ties keep first-seen order. */
function topCompetitors(answers: ApexgeoEngineResult[], n: number): string[] {
  const counts = new Map<string, { name: string; count: number; first: number }>();
  let seen = 0;
  for (const answer of answers) {
    const inAnswer = new Set<string>();
    for (const raw of answer.competitors_named) {
      const name = raw.trim();
      const id = name.toLowerCase();
      if (!name || inAnswer.has(id)) continue;
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

export function score(visibility: ApexgeoScan["ai_visibility"]): Scored | null {
  const t = tally(visibility);
  if (t.measured === 0) return null;
  const findings: ProspectFinding[] = [];
  if (t.mentioned === 0 && t.complete) {
    findings.push({
      code: "not_in_ai_answers",
      text: `AI assistants (${t.models.join(", ")}) did not name the business in any of ${t.measured} answers to local searches for its services.`,
    });
  }
  return { score: Math.round((t.mentioned / t.measured) * 100), findings };
}

export function result(scan: ApexgeoScan): ProspectSectionResult {
  const scored = score(scan.ai_visibility);
  if (!scored) return unavailable(key, "No AI assistant answered the test searches, so presence could not be measured.");
  const t = tally(scan.ai_visibility);
  return measured(key, scored, {
    mentionedIn: t.mentioned,
    answersMeasured: t.measured,
    models: t.models.join(", "),
    topCompetitors: t.competitors.length > 0 ? t.competitors.join(", ") : null,
  });
}
