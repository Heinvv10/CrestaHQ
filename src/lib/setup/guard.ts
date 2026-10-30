import "server-only";

import { NextResponse } from "next/server";
import { requireAgencyOwner } from "@/lib/auth/require-agency-owner";
import { getAdminDb } from "@/lib/firebase/admin";

/**
 * Shared gating for the setup-form API routes.
 *
 * Two independent gates protect these routes (defense in depth — see
 * docs/plans/setup-env-form.md):
 *   • permission — caller is the agency owner (`requireAgencyOwner`)
 *   • enablement — the Firestore toggle `appConfig/setup.formEnabled` is on
 *
 * The third gate (capability — `vercelConfigured()`) is checked per-route where
 * it actually matters, because a local-only `.env.local` write doesn't need
 * Vercel creds but a Vercel write / redeploy does.
 */

export const SETUP_DOC = "appConfig/setup";

export async function readFormEnabled(): Promise<boolean> {
  const snap = await getAdminDb().doc(SETUP_DOC).get();
  return snap.exists && snap.data()?.formEnabled === true;
}

/**
 * Returns the authed agency owner, OR a NextResponse the route should return
 * immediately (401/403). Enforces owner + the enablement toggle.
 */
export async function requireSetupEnabled(request: Request) {
  const auth = await requireAgencyOwner(request);
  if (auth instanceof NextResponse) return auth;

  if (!(await readFormEnabled())) {
    return NextResponse.json(
      { error: "The setup form is disabled." },
      { status: 403 },
    );
  }
  return auth;
}
