/** A parseable https URL — the only kind of Google review link the config routes accept. */
export function isHttpsUrl(s: string): boolean {
  try {
    return new URL(s).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * A Google review link (SP5 d2): only these are repeated by reminders, so a
 * reminder can never be pointed at any other site. The host must match exactly.
 */
const GOOGLE_REVIEW_HOSTS = new Set(["g.page", "search.google.com", "maps.app.goo.gl", "www.google.com", "google.com", "maps.google.com"]);

export function isGoogleReviewUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" && GOOGLE_REVIEW_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}
