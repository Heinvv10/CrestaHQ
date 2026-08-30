import "server-only";

/**
 * Stock photo lookup for funnel sections.
 *
 * Returns REAL, hotlinkable CDN URLs so the operator gets a page with pictures
 * on it, and can paste a different URL over any of them later. Deliberately
 * URL-based rather than uploaded: the image lives on the provider's CDN, the
 * funnel doc stays small, and swapping a picture is a text edit.
 *
 * OPTIONAL. Without `PEXELS_API_KEY` this returns nothing and the caller falls
 * back to showing the image brief plus a search link — never a broken <img>.
 * Fabricating URLs from a keyless endpoint was the alternative and it produces
 * dead images, which is worse than no image.
 *
 * Pexels is used because its licence permits commercial use with no attribution
 * requirement — important when the pictures land on a buyer's client's sales
 * page and nobody is going to add credits.
 */

const PEXELS_SEARCH = "https://api.pexels.com/v1/search";

export function stockImagesConfigured(): boolean {
  return !!process.env.PEXELS_API_KEY?.trim();
}

export interface StockImage {
  /** Hotlinkable CDN URL, sized for a full-width band. */
  url: string;
  /** Photographer + source, for operators who want to credit anyway. */
  credit: string;
  /** Page on Pexels, so the operator can find alternatives. */
  sourceUrl: string;
}

/**
 * Search stock photos. Never throws — an image is decoration, and a funnel
 * draft must not fail because a photo service was slow.
 */
export async function searchStockImages(
  query: string,
  count = 3,
): Promise<StockImage[]> {
  const key = process.env.PEXELS_API_KEY?.trim();
  const q = query.trim();
  if (!key || !q) return [];

  try {
    const url = new URL(PEXELS_SEARCH);
    url.searchParams.set("query", q.slice(0, 120));
    url.searchParams.set("per_page", String(Math.min(Math.max(count, 1), 10)));
    url.searchParams.set("orientation", "landscape");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(url, {
      headers: { Authorization: key },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!res.ok) {
      console.warn(`[stock-images] pexels ${res.status} for "${q}"`);
      return [];
    }

    const data = (await res.json()) as {
      photos?: {
        photographer?: string;
        url?: string;
        src?: { landscape?: string; large?: string; original?: string };
      }[];
    };

    return (data.photos ?? [])
      .map((p) => {
        const src = p.src?.landscape || p.src?.large || p.src?.original;
        if (!src) return null;
        return {
          url: src,
          credit: p.photographer ? `${p.photographer} / Pexels` : "Pexels",
          sourceUrl: p.url ?? "https://www.pexels.com",
        } satisfies StockImage;
      })
      .filter((x): x is StockImage => x !== null);
  } catch (err) {
    console.warn("[stock-images] search failed", err);
    return [];
  }
}

/** Manual-search fallback shown when no provider key is configured. */
export function stockSearchLink(query: string): string {
  return `https://www.pexels.com/search/${encodeURIComponent(query.trim())}/`;
}
