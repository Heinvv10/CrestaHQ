/**
 * The AI reply draft's voice check — a deterministic list of the tells that
 * make an owner reply read as machine-written ("Thank you so much! We're
 * thrilled…"). A hit is not a safety problem, only a voice one: the draft
 * seam (openrouter-draft.ts) asks the model once for a plainer rewrite and
 * refuses the draft (`slop`) when the rewrite hits too. Pure — no I/O.
 *
 * A rule whose pattern also matches the business's own reply guidelines is
 * not applied, like the contact guard: a sign-off the guidelines ask for
 * ("Cheers! The Team") must not refuse every draft.
 */

export interface SlopRule {
  id: string;
  re: RegExp;
}

const phrase = (id: string, words: string): SlopRule => ({ id, re: new RegExp(`\\b${words}\\b`, "iu") });

/** Every rule, in the order they are checked. Word-boundary phrases, case-insensitive. */
export const SLOP_RULES: readonly SlopRule[] = [
  { id: "exclamation", re: /!/u },
  { id: "emoji", re: /\p{Extended_Pictographic}/u },
  { id: "dash", re: /[—–]/u },
  phrase("thrilled", "thrilled"),
  phrase("delighted", "delighted"),
  phrase("truly", "truly"),
  phrase("genuinely", "genuinely"),
  phrase("appreciate_your_support", "appreciate\\s+your\\s+support"),
  phrase("dont_hesitate", "(?:don['’]t|do\\s+not)\\s+hesitate"),
  phrase("reach_out", "reach\\s+out"),
  phrase("look_forward_to", "look(?:ing)?\\s+forward\\s+to\\s+(?:serving|welcoming|helping)"),
  phrase("fifth_star", "(?:fifth|5th)\\s+star"),
  phrase("valued_customer", "valued\\s+customers?"),
  phrase("value_your_feedback", "we\\s+value\\s+your\\s+feedback"),
  phrase("means_the_world", "means\\s+the\\s+world"),
  phrase("rest_assured", "rest\\s+assured"),
  phrase("above_and_beyond", "above\\s+and\\s+beyond"),
  phrase("wonderful_review", "wonderful\\s+review"),
  phrase("kind_words", "kind\\s+words"),
  phrase("so_glad", "we(?:['’]re|\\s+are)\\s+so\\s+glad"),
];

/** The id of the first rule `text` breaks, or null. A rule `allowed` (the guidelines) also matches is skipped. */
export function slopHit(text: string, allowed: string | null = null): string | null {
  for (const rule of SLOP_RULES) {
    if (rule.re.test(text) && !(allowed && rule.re.test(allowed))) return rule.id;
  }
  return null;
}
