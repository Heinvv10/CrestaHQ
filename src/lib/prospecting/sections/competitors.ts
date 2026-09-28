/**
 * Competitor names from AI answers (C5). An engine's `competitors_named`
 * sometimes holds a word that is not a business ("Coverage", "Plumbers").
 * Filtering is deliberately conservative. A name is dropped only when it is
 *
 *   - a single common word or trade noun ("Coverage", "Plumbers"),
 *   - made entirely of common words ("The Best", "Local Services"), or
 *   - the prospect's own name.
 *
 * A multi-word name with a trade noun in it survives ("Affordable Plumbing",
 * "24/7 Plumbing"): small businesses are often named exactly like that. A
 * one-word brand ("Plumbquick") is kept too. The caller logs what was dropped.
 */

const COMMON = new Set([
  "a", "an", "and", "the", "or", "of", "in", "on", "for", "at", "by", "to", "near", "me", "my", "your", "our",
  "best", "top", "good", "great", "local", "nearby", "cheap", "affordable", "reliable", "trusted",
  "professional", "emergency", "24", "7", "hour", "hours", "other", "others", "various", "many", "several",
  "option", "options", "coverage", "area", "areas", "city", "town", "region", "price", "prices", "pricing",
  "quote", "quotes", "review", "reviews", "rating", "ratings", "google", "maps", "yelp", "facebook",
  "website", "directory", "listing", "listings", "home", "house", "residential", "commercial", "insurance",
  "service", "services", "company", "companies", "business", "businesses", "contractor", "contractors",
  "provider", "providers", "expert", "experts", "specialist", "specialists", "team", "repair", "repairs",
  "installation", "installations", "maintenance",
]);

/** Dropped on their own; in a multi-word name they make it a business name. */
const TRADE = new Set([
  "plumber", "plumbers", "plumbing", "electrician", "electricians", "electrical", "builder", "builders",
  "painter", "painters", "cleaner", "cleaners", "cleaning", "locksmith", "locksmiths", "mechanic", "mechanics",
  "dentist", "dentists", "lawyer", "lawyers", "attorney", "attorneys", "accountant", "accountants",
]);

/** Lower-cased words, punctuation and a trailing "(Pty) Ltd" / "CC" removed. */
function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/ (pty )?(ltd|cc)$/, "");
}

export function isCompetitorName(name: string, ownName: string | null): boolean {
  const norm = normName(name);
  const words = norm.split(" ").filter(Boolean);
  if (words.length === 0 || words.every((w) => COMMON.has(w))) return false;
  if (words.length === 1 && TRADE.has(words[0]!)) return false;
  return !ownName || norm !== normName(ownName);
}
