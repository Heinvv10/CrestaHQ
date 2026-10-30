import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getAdminDb } from "@/lib/firebase/admin";
import { resolveSubdomain } from "@/lib/funnels/subdomains";
import FunnelLandingPage, {
  generateMetadata as funnelMetadata,
} from "@/app/fn/[subAccountId]/[slug]/page";

export const dynamic = "force-dynamic";

/**
 * Vanity-subdomain resolver — the internal target of the middleware host
 * rewrite (`7dsummer.leadstack.dev/` → `/fnh/7dsummer`). Never linked to
 * directly.
 *
 * Looks up the global claim, then DELEGATES to the real funnel page component
 * with the resolved params — one rendering path, so every funnel feature
 * (sections, motion, footer, metadata) works identically on both URLs with
 * nothing to keep in sync. Server components are plain async functions, which
 * is what makes the delegation legal.
 *
 * The claim stores the funnel ID, not the slug — a slug rename must not break
 * the vanity host — so this reads the funnel doc to get the current slug.
 */

async function resolveParams(
  subdomain: string,
): Promise<{ subAccountId: string; slug: string } | null> {
  const claim = await resolveSubdomain(subdomain);
  if (!claim) return null;
  const snap = await getAdminDb()
    .doc(`subAccounts/${claim.subAccountId}/funnels/${claim.funnelId}`)
    .get();
  const slug = snap.data()?.slug as string | undefined;
  if (!slug) return null;
  return { subAccountId: claim.subAccountId, slug };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ subdomain: string }>;
}): Promise<Metadata> {
  const { subdomain } = await params;
  const resolved = await resolveParams(subdomain);
  if (!resolved) return { title: "Not found" };
  return funnelMetadata({ params: Promise.resolve(resolved) });
}

export default async function FunnelHostPage({
  params,
}: {
  params: Promise<{ subdomain: string }>;
}) {
  const { subdomain } = await params;
  const resolved = await resolveParams(subdomain);
  if (!resolved) notFound();
  return FunnelLandingPage({ params: Promise.resolve(resolved) });
}
