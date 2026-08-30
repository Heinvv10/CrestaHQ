import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireAgencyOwner } from "@/lib/auth/require-agency-owner";
import { vercelConfigured } from "@/lib/vercel/client";
import { isLocalDev } from "@/lib/setup/env-file";
import { SETUP_DOC, readFormEnabled } from "@/lib/setup/guard";

/**
 * Agency-owner-only read + write of the setup-form enable state.
 *
 * GET  — reports capability (`vercelWired`, `isLocal`) + permission
 *        (`formEnabled`) so the UI can gray the toggle and explain why.
 * PATCH — flips `appConfig/setup.formEnabled`. Turning it ON requires the
 *        Vercel preflight vars to be present (capability), so an owner can't
 *        enable a form that physically can't write anything.
 */

export async function GET(request: Request) {
  const auth = await requireAgencyOwner(request);
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json({
    ok: true,
    vercelWired: vercelConfigured(),
    isLocal: isLocalDev(),
    formEnabled: await readFormEnabled(),
  });
}

export async function PATCH(request: Request) {
  const auth = await requireAgencyOwner(request);
  if (auth instanceof NextResponse) return auth;

  let body: { formEnabled?: unknown };
  try {
    body = (await request.json()) as { formEnabled?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.formEnabled !== "boolean") {
    return NextResponse.json(
      { error: "`formEnabled` must be a boolean." },
      { status: 400 },
    );
  }

  // Can't enable a form that has no way to write env vars.
  if (body.formEnabled === true && !vercelConfigured()) {
    return NextResponse.json(
      {
        error:
          "Set VERCEL_TOKEN, VERCEL_PROJECT_ID, and VERCEL_DEPLOY_HOOK_URL (and redeploy once) before enabling the setup form.",
      },
      { status: 400 },
    );
  }

  try {
    await getAdminDb().doc(SETUP_DOC).set(
      {
        formEnabled: body.formEnabled,
        updatedAt: FieldValue.serverTimestamp(),
        updatedByUid: auth.uid,
      },
      { merge: true },
    );
  } catch (err) {
    console.error("[agency/setup/config] write failed", err);
    return NextResponse.json({ error: "Save failed." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, formEnabled: body.formEnabled });
}
