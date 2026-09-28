import { SEVERITY_ORDER } from "@/lib/prospecting/severity";
import type { PublicReportSection } from "@/lib/prospecting/public-sections";
import type { ProspectSectionKey } from "@/types";

/**
 * What the redesigned report page ("Story", R3) derives from the public
 * sections: the headline finding and which hero it gets, the Top 3, the
 * "N of M areas need work" count and each score's traffic light. Pure, so
 * the unit tests pin the rules without rendering.
 */

export type PublicFinding = PublicReportSection["findings"][number];
export type RankedFinding = PublicFinding & { section: ProspectSectionKey };

/**
 * Fixed traffic-light colours. Never derived from the agency brand colour,
 * so a slow website is always red (SOW "Settled" 1).
 */
export const TRAFFIC_LIGHT = {
  good: { color: "#1E874B", label: "Good" },
  needsWork: { color: "#C2410C", label: "Needs work" },
  poor: { color: "#9F1D1D", label: "Poor" },
} as const;

export type TrafficLight = keyof typeof TRAFFIC_LIGHT;

/**
 * 100 is good: a score comes only from findings, so anything lower has at
 * least one and is counted as needing work. Under 50 is poor.
 */
export function trafficLight(score: number): TrafficLight {
  if (score >= 100) return "good";
  return score >= 50 ? "needsWork" : "poor";
}

const RANK = new Map<string, number>(SEVERITY_ORDER.map((code, i) => [code, i]));

/**
 * Findings of measured (`ok`) sections, worst first — the same ranking and
 * tie-break as the stored headline (`severity.ts`): section order, then
 * finding order.
 */
export function rankedFindings(sections: PublicReportSection[]): RankedFinding[] {
  return sections
    .filter((s) => s.status === "ok")
    .flatMap((s) => s.findings.map((f) => ({ ...f, section: s.key })))
    .map((f, i) => ({ f, i, rank: RANK.get(f.code) ?? SEVERITY_ORDER.length }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ f }) => f);
}

/** Public sections that have a score, and how many of them have a finding. */
export function areaCount(sections: PublicReportSection[]): { needWork: number; scored: number } {
  const scored = sections.filter((s) => s.status === "ok" && s.score !== null);
  return { needWork: scored.filter((s) => s.findings.length > 0).length, scored: scored.length };
}

/** The questions put to AI (C7), stored publicly as question1, question2… */
export function aiQuestions(section: PublicReportSection | undefined): string[] {
  if (!section) return [];
  return Object.entries(section.details)
    .filter((e): e is [string, string] => /^question\d+$/.test(e[0]) && typeof e[1] === "string")
    .sort((a, b) => Number(a[0].slice(8)) - Number(b[0].slice(8)))
    .map(([, v]) => v);
}

export interface AiHook {
  question: string;
  competitors: string | null;
  mentioned: number;
  measured: number;
}

/**
 * The AI chat-bubble hero shows only when the headline finding is the AI
 * presence one AND the report carries its questions (a report scored before
 * R0 has none, and gets the generic hero).
 */
export function aiHook(sections: PublicReportSection[], headline: RankedFinding | null): AiHook | null {
  if (headline?.section !== "ai_presence") return null;
  const section = sections.find((s) => s.key === "ai_presence");
  const [question] = aiQuestions(section);
  const measured = section?.details.answersMeasured;
  const mentioned = section?.details.mentionedIn;
  if (!question || typeof measured !== "number" || typeof mentioned !== "number" || measured < 1) return null;
  const competitors = section?.details.topCompetitors;
  return { question, competitors: typeof competitors === "string" ? competitors : null, mentioned, measured };
}

/** Digits of an E.164 number as a wa.me link, or null when there is none. */
export function whatsappHref(number: string | null): string | null {
  const digits = number?.replace(/\D/g, "") ?? "";
  return digits ? `https://wa.me/${digits}` : null;
}
