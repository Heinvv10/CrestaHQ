/**
 * Competitor names from AI answers (C5). An engine's `competitors_named`
 * sometimes holds a word that is not a business ("Coverage", "Plumbers").
 * Filtering is deliberately conservative: a name is dropped only when every
 * word in it is a common word or a generic trade noun, or when it is the
 * prospect's own name. A one-word brand ("Plumbquick") is kept. The caller
 * logs what was dropped.
 */

const GENERIC = new Set([
  // Common words
  "a", "an", "and", "the", "or", "of", "in", "on", "for", "at", "by", "to", "near", "me", "my", "your", "our",
  "best", "top", "good", "great", "local", "nearby", "cheap", "affordable", "reliable", "trusted",
  "professional", "emergency", "24", "7", "hour", "hours", "other", "others", "various", "many", "several",
  "option", "options", "coverage", "area", "areas", "city", "town", "region", "price", "prices", "pricing",
  "quote", "quotes", "review", "reviews", "rating", "ratings", "google", "maps", "yelp", "facebook",
  "website", "directory", "listing", "listings", "home", "house", "residential", "commercial", "insurance",
  // Generic business and trade nouns
  "service", "services", "company", "companies", "business", "businesses", "contractor", "contractors",
  "provider", "providers", "expert", "experts", "specialist", "specialists", "team", "repair", "repairs",
  "installation", "installations", "maintenance", "plumber", "plumbers", "plumbing", "electrician",
  "electricians", "electrical", "builder", "builders", "painter", "painters", "cleaner", "cleaners",
  "cleaning", "locksmith", "locksmiths", "mechanic", "mechanics", "dentist", "dentists", "lawyer", "lawyers",
  "attorney", "attorneys", "accountant", "accountants",
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
  if (words.length === 0 || words.every((w) => GENERIC.has(w))) return false;
  return !ownName || norm !== normName(ownName);
}
