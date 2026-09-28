import { normaliseForContacts } from "./contact-guard";

/**
 * The AI reply draft's voice check — a deterministic list of the tells that
 * make an owner reply read as machine-written ("Thank you so much! We're
 * thrilled…"). A hit is not a safety problem, only a voice one: the draft
 * seam (openrouter-draft.ts) asks the model once for a plainer rewrite and
 * refuses the draft (`slop`) when the rewrite hits too. Pure — no I/O.
 *
 * The business's reply guidelines NEVER switch a rule off: they only ever
 * add bans (through the prompt). A guideline sign-off with "!" or an emoji
 * ("Cheers! The Team") therefore fails every draft that follows it.
 *
 * The text is normalised first, so look-alikes cannot slip past: the contact
 * guard's normalisation (NFKC — fullwidth letters and "！" fold to ASCII —
 * format characters such as ZWJ, ZWSP and the soft hyphen removed, lower
 * case), then Cyrillic and Greek letters that look Latin read as Latin. The
 * reviewer's first name and the business name are then removed as whole
 * tokens (a reviewer called "Truly", a business called "Delighted Cleaning").
 */

export interface SlopRule {
  id: string;
  re: RegExp;
}

const phrase = (id: string, words: string): SlopRule => ({ id, re: new RegExp(`\\b${words}\\b`, "iu") });

/** Every rule, in the order they are checked. Word-boundary phrases, case-insensitive, on normalised text. */
export const SLOP_RULES: readonly SlopRule[] = [
  { id: "exclamation", re: /[!！¡‼⁉]/u },
  // Pictographs except © ® ™, flags, and the common text emoticons.
  { id: "emoji", re: /(?![©®™])\p{Extended_Pictographic}|\p{Regional_Indicator}|(?<!\S)[:;]-?[)d](?![\p{L}\p{N}])/iu },
  // An en or em dash BETWEEN DIGITS is a range ("08:00–17:00", "5–10"), not a clause dash.
  { id: "dash", re: /[‒―⸺⸻﹘﹣]|(?<!\d)[–—]|[–—](?!\d)|\s-{1,2}\s|--/u },
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

/** Lower-case Cyrillic and Greek letters that look Latin (the text is lower-cased before this). */
const LOOKALIKES: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ѕ: "s",
  ο: "o", α: "a", ε: "e", ι: "i", ν: "v",
};
const LOOKALIKE_RE = new RegExp(`[${Object.keys(LOOKALIKES).join("")}]`, "gu");

const normalise = (t: string) => normaliseForContacts(t).replace(LOOKALIKE_RE, (c) => LOOKALIKES[c]);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The id of the first rule `text` breaks, or null. `names` (the reviewer's
 * first name, the business name) are removed first, case-insensitively and
 * as whole tokens only.
 */
export function slopHit(text: string, names: ReadonlyArray<string | null> = []): string | null {
  let t = normalise(text);
  for (const name of names) {
    const n = name ? normalise(name).trim() : "";
    if (n) t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(n)}(?![\\p{L}\\p{N}])`, "gu"), " ");
  }
  for (const rule of SLOP_RULES) {
    if (rule.re.test(t)) return rule.id;
  }
  return null;
}
