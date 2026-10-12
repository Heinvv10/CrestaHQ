import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { transitionWebsite } from "@/lib/server/websites-service";
import { siteAddress, type WebsiteDoc, type WebsitePageSpeed } from "@/types/website";

/**
 * Google PageSpeed Insights for a published site (mobile). Called ~2 minutes
 * after publish by a QStash callback (the settle schedules it).
 * Keyless PSI is rate-limited but plenty for one run per publish.
 * Never throws on the PSI call — failures are stored on the doc as
 * `pagespeed.error`.
 *
 * The only host fetched is Google's fixed PSI endpoint; Google, not this
 * server, loads the site. The scores are written through `transitionWebsite`
 * and only onto the build that was measured: a site rebuilt, reset or given
 * another address during the (up to 55 s) call is left as it now is.
 */

const PSI = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const CATEGORIES = ["performance", "seo", "accessibility", "best-practices"] as const;

function score(categories: Record<string, { score?: number | null } | undefined>, key: string): number | null {
  const s = categories?.[key]?.score;
  return typeof s === "number" ? Math.round(s * 100) : null;
}

export async function runPageSpeed(subAccountId: string, siteId: string): Promise<WebsitePageSpeed | null> {
  const ref = getAdminDb().doc(`subAccounts/${subAccountId}/website/${siteId}`);
  const snap = await ref.get();
  const site = snap.data() as WebsiteDoc | undefined;
  if (!snap.exists || !site || site.subAccountId !== subAccountId || site.status !== "ready") return null;
  const url = siteAddress(site);
  if (!url || !url.startsWith("https://")) return null;

  const qs = new URLSearchParams({ url, strategy: "mobile" });
  const key = process.env.PAGESPEED_API_KEY?.trim();
  if (key) qs.set("key", key);
  for (const c of CATEGORIES) qs.append("category", c);
  let result: WebsitePageSpeed;
  try {
    const res = await fetch(`${PSI}?${qs.toString()}`, { signal: AbortSignal.timeout(55_000), cache: "no-store" });
    const body = (await res.json().catch(() => ({}))) as {
      lighthouseResult?: { categories?: Record<string, { score?: number | null }> };
      error?: { message?: string };
    };
    if (!res.ok || !body.lighthouseResult?.categories) {
      if (res.status === 429 && !key) {
        throw new Error("Google's free shared quota is used up — add a PAGESPEED_API_KEY to the deployment for reliable checks.");
      }
      throw new Error(body.error?.message || `PageSpeed returned ${res.status}`);
    }
    const cats = body.lighthouseResult.categories;
    result = {
      url,
      strategy: "mobile",
      performance: score(cats, "performance"),
      seo: score(cats, "seo"),
      accessibility: score(cats, "accessibility"),
      bestPractices: score(cats, "best-practices"),
      error: null,
      at: FieldValue.serverTimestamp(),
    };
  } catch (err) {
    result = {
      url,
      strategy: "mobile",
      performance: null,
      seo: null,
      accessibility: null,
      bestPractices: null,
      error: err instanceof Error ? err.message.slice(0, 200) : "PageSpeed check failed",
      at: FieldValue.serverTimestamp(),
    };
  }
  const written = await transitionWebsite(
    ref,
    {
      expectJobId: site.gitpageJobId ?? null,
      fromStatuses: ["ready"],
      when: (fresh) => siteAddress(fresh) === url,
    },
    { pagespeed: result, updatedAt: FieldValue.serverTimestamp() },
  );
  return written.applied ? result : null;
}
