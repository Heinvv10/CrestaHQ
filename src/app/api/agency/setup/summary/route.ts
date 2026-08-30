import "server-only";

import { NextResponse } from "next/server";
import { requireAgencyOwner } from "@/lib/auth/require-agency-owner";
import { GROUPS, evaluateGroup } from "@/lib/setup/catalog";
import { LANDING_VARIANT } from "@/config/landing";

/**
 * Lightweight setup summary powering the Get-started page's setup banner.
 *
 * Owner-gated but — unlike `/api/agency/setup/status` — deliberately NOT
 * gated on the setup-form toggle: its whole job is to point a brand-new
 * owner AT Guided setup before they've enabled anything. Safe to expose
 * because it returns counts + group titles only (which are public knowledge,
 * they're in the repo) — no key names, no values, and no Vercel round-trip.
 * Pure in-memory evaluation of `process.env`, so it's instant.
 *
 * Required-vs-optional maps straight onto the catalog's tiers:
 *   • tier "boot"    → required to run. Any group at "error" (missing
 *     required key or an error-level deep check) makes `requiredComplete`
 *     false.
 *   • tier "feature" → optional integrations; "off" is a fine steady state
 *     but each unconfigured/partial group is reported as remaining.
 */
export async function GET(request: Request) {
  const auth = await requireAgencyOwner(request);
  if (auth instanceof NextResponse) return auth;

  const getValue = (k: string) => process.env[k];
  const relevant = GROUPS.filter((g) => g.tier !== "preflight").filter(
    (g) => !g.variant || g.variant === LANDING_VARIANT,
  );

  let missingRequiredKeys = 0;
  const requiredIssues: string[] = [];
  let featuresConfigured = 0;
  const featuresRemaining: string[] = [];

  for (const g of relevant) {
    const res = evaluateGroup(g, getValue);
    if (g.tier === "boot") {
      if (res.status === "error") {
        missingRequiredKeys += res.missingReq.length;
        requiredIssues.push(g.title);
      }
    } else if (res.status === "ok") {
      featuresConfigured += 1;
    } else {
      featuresRemaining.push(g.title);
    }
  }

  return NextResponse.json({
    ok: true,
    requiredComplete: requiredIssues.length === 0,
    missingRequiredKeys,
    requiredIssues,
    featuresConfigured,
    featuresTotal: featuresConfigured + featuresRemaining.length,
    featuresRemaining,
  });
}
