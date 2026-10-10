import "server-only";

import { NextResponse } from "next/server";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, type EmailAccount } from "@/lib/comms/resend";
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
const EMAIL_TITLE = "Email";
const SMTP_SCAN_LIMIT = 50;

/**
 * Email is configured by the shared Resend env OR by a sub-account's own
 * verified SMTP (`emailIsConfigured(sub)`) — an SMTP-only deployment has no
 * Resend env at all and must not read "Not set up". Only
 * consulted when the env verdict is "off"; a half-set Resend stays visible.
 * Fails soft (logged) to the env verdict when the read fails.
 */
async function anySubAccountSendsViaSmtp(agencyId: string): Promise<boolean> {
  try {
    const snap = await getAdminDb()
      .collection("subAccounts")
      .where("agencyId", "==", agencyId)
      .where("emailProvider", "==", "smtp")
      .limit(SMTP_SCAN_LIMIT)
      .get();
    return snap.docs.some((d) => emailIsConfigured(d.data() as EmailAccount));
  } catch (e) {
    console.warn("[setup-summary] SMTP sub-account lookup failed", e);
    return false;
  }
}

export async function GET(request: Request) {
  const auth = await requireAgencyOwnerAny(request);
  if (auth instanceof NextResponse) return auth;

  const getValue = (k: string) => process.env[k];
  const relevant = GROUPS.filter((g) => g.tier !== "preflight").filter(
    (g) => !g.variant || g.variant === LANDING_VARIANT,
  );

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

  for (const g of relevant) {
    const res = evaluateGroup(g, getValue);
    if (g.title === EMAIL_TITLE && res.status === "off") {
      if (await anySubAccountSendsViaSmtp(auth.agencyId!)) res.status = "ok";
    }
    groups.push({
      title: g.title,
      tier: g.tier,
      status: res.status,
      off: g.off ?? null,
    });
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
    groups,
  });
}
