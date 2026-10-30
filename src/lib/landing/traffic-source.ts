/**
 * Traffic-source classification for the landing funnel's attribution
 * rollup. Answers "where did this click ORIGINATE" in the channel sense
 * — YouTube, Google, an ad, a newsletter, direct — as opposed to the
 * geographic sense (country/city) which the IP lookup handles.
 *
 * Signals, in priority order:
 *   1. Explicit UTM tagging (`utm_source` / `utm_medium`) — the gold
 *      standard; if the marketer tagged the link we trust it verbatim.
 *   2. Ad-click ids (`gclid` → Google Ads, `fbclid` → Meta Ads) — proves
 *      paid even when UTMs are missing.
 *   3. `document.referrer` host — organic/social/referral inference.
 *   4. Nothing → Direct.
 *
 * Pure + dependency-free so the heartbeat route (server) can call it and
 * it stays trivially testable. Every branch returns a `{ key, label }`:
 * `key` is a Firestore-safe doc id (`[a-z0-9-]`), `label` is the display
 * string for the dashboard.
 */

export interface TrafficSource {
  /** Firestore-safe doc id for the `landingSources` collection. */
  key: string;
  /** Human-readable label for the dashboard table. */
  label: string;
}

export interface TrafficSignals {
  referrer?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  gclid?: string | null;
  fbclid?: string | null;
}

/** Known hosts → a stable bucket. Substring-matched against the referrer
 *  host, so `www.google.com`, `google.co.uk`, `news.google.com` all map to
 *  `google`. Order matters: first hit wins. */
const HOST_BUCKETS: { match: string; key: string; label: string }[] = [
  { match: "youtube.", key: "youtube", label: "YouTube" },
  { match: "youtu.be", key: "youtube", label: "YouTube" },
  { match: "google.", key: "google", label: "Google (organic)" },
  { match: "bing.", key: "bing", label: "Bing" },
  { match: "duckduckgo.", key: "duckduckgo", label: "DuckDuckGo" },
  { match: "instagram.", key: "instagram", label: "Instagram" },
  { match: "facebook.", key: "facebook", label: "Facebook" },
  { match: "fb.com", key: "facebook", label: "Facebook" },
  { match: "l.facebook", key: "facebook", label: "Facebook" },
  { match: "t.co", key: "twitter", label: "X / Twitter" },
  { match: "twitter.", key: "twitter", label: "X / Twitter" },
  { match: "x.com", key: "twitter", label: "X / Twitter" },
  { match: "linkedin.", key: "linkedin", label: "LinkedIn" },
  { match: "lnkd.in", key: "linkedin", label: "LinkedIn" },
  { match: "reddit.", key: "reddit", label: "Reddit" },
  { match: "tiktok.", key: "tiktok", label: "TikTok" },
  { match: "pinterest.", key: "pinterest", label: "Pinterest" },
  { match: "t.me", key: "telegram", label: "Telegram" },
  { match: "wa.me", key: "whatsapp", label: "WhatsApp" },
  { match: "whatsapp.", key: "whatsapp", label: "WhatsApp" },
  { match: "mail.google", key: "email", label: "Email" },
  { match: "outlook.", key: "email", label: "Email" },
];

/** Android/iOS in-app browsers hand us an `android-app://<package>`
 *  referrer (or sometimes the bare package) instead of a web host. Map the
 *  common social apps so a click from the YouTube/Instagram/etc. app is
 *  attributed to that channel, not dropped to a raw package name. Matched
 *  as a substring against the lower-cased raw referrer. */
const APP_PACKAGES: { match: string; key: string; label: string }[] = [
  { match: "com.google.android.youtube", key: "youtube", label: "YouTube" },
  {
    match: "com.google.android.googlequicksearchbox",
    key: "google",
    label: "Google (organic)",
  },
  { match: "com.instagram.android", key: "instagram", label: "Instagram" },
  { match: "com.facebook.katana", key: "facebook", label: "Facebook" },
  { match: "com.facebook.lite", key: "facebook", label: "Facebook" },
  { match: "com.zhiliaoapp.musically", key: "tiktok", label: "TikTok" },
  { match: "com.ss.android", key: "tiktok", label: "TikTok" },
  { match: "com.twitter.android", key: "twitter", label: "X / Twitter" },
  { match: "com.linkedin.android", key: "linkedin", label: "LinkedIn" },
  { match: "com.reddit.frontpage", key: "reddit", label: "Reddit" },
  { match: "com.pinterest", key: "pinterest", label: "Pinterest" },
  { match: "org.telegram", key: "telegram", label: "Telegram" },
  { match: "com.whatsapp", key: "whatsapp", label: "WhatsApp" },
];

/** Normalize any free-text token to a Firestore-safe doc id. */
function toKey(raw: string): string {
  const key = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return key || "other";
}

/** Title-case a raw utm token for display when we have no nicer label. */
function toLabel(raw: string): string {
  const cleaned = raw.trim().replace(/[-_]+/g, " ");
  return cleaned.slice(0, 60) || "Other";
}

/** Extract the bare host from a referrer URL, lower-cased. Null on any
 *  unparseable / empty value. */
function hostOf(referrer: string | null | undefined): string | null {
  if (!referrer) return null;
  try {
    return new URL(referrer).host.toLowerCase();
  } catch {
    return null;
  }
}

function isPaidMedium(medium: string | null | undefined): boolean {
  if (!medium) return false;
  const m = medium.toLowerCase();
  return (
    m.includes("cpc") ||
    m.includes("ppc") ||
    m.includes("paid") ||
    m.includes("ads") ||
    m === "display"
  );
}

/**
 * Classify a landing visit into a single traffic source. Runs once per
 * session (first heartbeat), and the result is persisted on the
 * liveVisitor doc so later clicks + the purchase webhook attribute to the
 * same bucket without re-deriving.
 */
export function classifyTrafficSource(signals: TrafficSignals): TrafficSource {
  const { referrer, utmSource, utmMedium, gclid, fbclid } = signals;

  // 1. Explicit UTM source always wins — honor the marketer's tagging.
  if (utmSource && utmSource.trim()) {
    const paid = isPaidMedium(utmMedium);
    const key = toKey(utmSource);
    // Give the common paid buckets nicer labels; everything else is shown
    // verbatim so e.g. utm_source=spring-newsletter reads as "Spring
    // newsletter".
    if (key === "google")
      return { key: paid ? "google-ads" : "google", label: paid ? "Google Ads" : "Google (organic)" };
    if (key === "facebook" || key === "fb")
      return { key: paid ? "meta-ads" : "facebook", label: paid ? "Meta Ads" : "Facebook" };
    if (key === "instagram" || key === "ig")
      return { key: paid ? "meta-ads" : "instagram", label: paid ? "Meta Ads" : "Instagram" };
    if (key === "youtube")
      return { key: paid ? "youtube-ads" : "youtube", label: paid ? "YouTube Ads" : "YouTube" };
    return {
      key: paid ? `${key}-ads` : key,
      label: paid ? `${toLabel(utmSource)} Ads` : toLabel(utmSource),
    };
  }

  // 2. Ad-click ids prove paid traffic even with no UTM.
  if (gclid && gclid.trim()) return { key: "google-ads", label: "Google Ads" };
  if (fbclid && fbclid.trim()) return { key: "meta-ads", label: "Meta Ads" };

  // 3. In-app browser referrers (`android-app://com.google.android.youtube`
  // etc.) — checked against the raw referrer before host parsing, since
  // these aren't standard web hosts.
  if (referrer) {
    const raw = referrer.toLowerCase();
    for (const app of APP_PACKAGES) {
      if (raw.includes(app.match)) return { key: app.key, label: app.label };
    }
  }

  // 4. Referrer host inference.
  const host = hostOf(referrer);
  if (host) {
    for (const bucket of HOST_BUCKETS) {
      if (host.includes(bucket.match)) {
        return { key: bucket.key, label: bucket.label };
      }
    }
    // Unknown external site → a referral, labelled with the bare domain
    // (strip a leading www. for readability).
    const domain = host.replace(/^www\./, "");
    return { key: `ref-${toKey(domain)}`, label: domain };
  }

  // 5. No referrer, no tagging → typed the URL / bookmark / stripped app.
  return { key: "direct", label: "Direct" };
}
