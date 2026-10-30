import "server-only";

import { NextResponse } from "next/server";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";
import { deploymentSetupGroups } from "@/lib/setup/deployment-status";

/**
 * Lightweight setup summary powering the Get-started page's setup banner.
 *
 * Owner-gated but — unlike `/api/agency/setup/status` — deliberately NOT
 * gated on the setup-form toggle: its whole job is to point a brand-new
 * owner AT Guided setup before they've enabled anything. Safe to expose
 * because it returns counts + group titles only (which are public knowledge,
 * they're in the repo) — no key names, no values, and no Vercel round-trip.
 * Evaluation of `process.env` is in-memory; the one Firestore read is the
 * Email row's "does any sub-account send through verified SMTP" check.
 *
 * Required-vs-optional maps straight onto the catalog's tiers:
 *   • tier "boot"    → required to run. Any group at "error" (missing
 *     required key or an error-level deep check) makes `requiredComplete`
 *     false.
 *   • tier "feature" → optional integrations; "off" is a fine steady state
 *     but each unconfigured/partial group is reported as remaining.
 */
export async function GET(request: Request) {
  const auth = await requireAgencyOwnerAny(request);
  if (auth instanceof NextResponse) return auth;

  let missingRequiredKeys = 0;
  const requiredIssues: string[] = [];
  let featuresConfigured = 0;
  const featuresRemaining: string[] = [];
  // Per-group snapshot for the owner's setup-snapshot dialog. Titles +
  // statuses only (plus the catalog's own "what's off" copy) — no key names
  // and no values.
  const groups: {
    title: string;
    tier: string;
    status: string;
    off: string | null;
  }[] = [];

  for (const g of await deploymentSetupGroups(auth.agencyId!)) {
    groups.push({ title: g.title, tier: g.tier, status: g.status, off: g.off });
    if (g.tier === "boot") {
      if (g.status === "error") {
        missingRequiredKeys += g.missingRequired;
        requiredIssues.push(g.title);
      }
    } else if (g.status === "ok") {
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
    groups,
  });
}
