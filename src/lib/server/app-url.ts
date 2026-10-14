import "server-only";

/**
 * The deployment's own public origin, with redirects resolved.
 *
 * NEXT_PUBLIC_APP_URL on an apex domain often 307s to www. A cross-origin
 * fetch — a built site's form POST, the chat widget's config call — fails
 * its CORS preflight on a redirect ("Failed to fetch", a silent widget), so
 * a URL baked into someone else's page must be the one that answers.
 *
 * A neutral module on purpose: the website hand-off and Web Voice both need
 * this, and Web Voice is itself imported by the hand-off.
 *
 * Plain `fetch` with redirect-follow is right HERE ONLY: the URL is the
 * operator's own NEXT_PUBLIC_APP_URL. Never pass a tenant's or a third
 * party's URL through this — those go through `publicFetch`, one checked hop
 * at a time (see `resolveLiveUrl` in website-handoff-service.ts).
 */
async function followOwnRedirects(url: string, probePath = ""): Promise<string> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}${probePath}`, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
    const final = res.url;
    if (!final) return url;
    return probePath && final.endsWith(probePath) ? final.slice(0, -probePath.length) : final;
  } catch {
    return url;
  }
}

/** The deployment's public https origin with redirects resolved (apex → www), or null. */
export async function resolvedAppUrl(): Promise<string | null> {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
  if (!/^https:\/\/[^\s/]+$/i.test(appUrl)) return null;
  const final = await followOwnRedirects(appUrl, "/widget.js");
  try {
    const origin = new URL(final).origin;
    return /^https:\/\//.test(origin) ? origin : appUrl;
  } catch {
    return appUrl;
  }
}
