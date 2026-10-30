/**
 * Video embed normalisation for funnel landing pages.
 *
 * SECURITY, not convenience: the landing page renders this URL inside an
 * <iframe> on a page WE host. Accepting an arbitrary URL would let an operator
 * (or anyone who could write a funnel doc) frame anything on their sub-account's
 * public page. So the host is allow-listed and the embed URL is RECONSTRUCTED
 * from the extracted id rather than passed through — a URL that doesn't parse
 * into a known shape is rejected outright, never rendered as-is.
 *
 * Client-safe (pure) so the builder can preview exactly what the server stores.
 */

export interface VideoEmbed {
  /** Safe, reconstructed embed URL. */
  url: string;
  provider: "youtube" | "vimeo" | "loom" | "wistia";
}

/** Returns null when the URL isn't a recognised, embeddable video. */
export function normaliseVideoUrl(raw: string): VideoEmbed | null {
  const input = raw.trim();
  if (!input) return null;

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;

  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();

  // ── YouTube ──────────────────────────────────────────────────────
  if (host === "youtube.com" || host === "m.youtube.com") {
    const id = parsed.searchParams.get("v");
    if (id && /^[\w-]{6,20}$/.test(id)) {
      return { url: `https://www.youtube.com/embed/${id}`, provider: "youtube" };
    }
    const embedMatch = parsed.pathname.match(/^\/embed\/([\w-]{6,20})$/);
    if (embedMatch) {
      return {
        url: `https://www.youtube.com/embed/${embedMatch[1]}`,
        provider: "youtube",
      };
    }
    return null;
  }
  if (host === "youtu.be") {
    const id = parsed.pathname.replace(/^\//, "");
    if (/^[\w-]{6,20}$/.test(id)) {
      return { url: `https://www.youtube.com/embed/${id}`, provider: "youtube" };
    }
    return null;
  }

  // ── Vimeo ────────────────────────────────────────────────────────
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const id = parsed.pathname.match(/(\d{6,})/)?.[1];
    if (id) {
      return { url: `https://player.vimeo.com/video/${id}`, provider: "vimeo" };
    }
    return null;
  }

  // ── Loom ─────────────────────────────────────────────────────────
  if (host === "loom.com") {
    const id = parsed.pathname.match(/\/(?:share|embed)\/([0-9a-f]{16,})/i)?.[1];
    if (id) {
      return { url: `https://www.loom.com/embed/${id}`, provider: "loom" };
    }
    return null;
  }

  // ── Wistia ───────────────────────────────────────────────────────
  if (host.endsWith("wistia.com") || host.endsWith("wistia.net")) {
    const id = parsed.pathname.match(/\/(?:medias|embed\/iframe)\/([\w-]{8,})/)?.[1];
    if (id) {
      return {
        url: `https://fast.wistia.net/embed/iframe/${id}`,
        provider: "wistia",
      };
    }
    return null;
  }

  return null;
}

export const VIDEO_HELP =
  "Paste a YouTube, Vimeo, Loom or Wistia link. Other hosts are rejected — the video is embedded on your public page, so we only allow known providers.";
