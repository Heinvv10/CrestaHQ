import "server-only";

import { NextResponse } from "next/server";
import { requireAgencyOwner } from "@/lib/auth/require-agency-owner";
import { readFormEnabled } from "@/lib/setup/guard";
import { isWritableKey, keyVariant, validateVar } from "@/lib/setup/catalog";
import { vercelConfigured, upsertEnvVars } from "@/lib/vercel/client";
import { isLocalDev, writeEnvLocalVars } from "@/lib/setup/env-file";
import { LANDING_VARIANT } from "@/config/landing";

/**
 * Write submitted env vars to Vercel and/or the local `.env.local`.
 *
 * Body: { vars: [{ key, value }], targets: { vercel?: boolean, local?: boolean } }
 *
 * Security posture — gating matches each target's blast radius:
 *   • Base: agency owner (requireAgencyOwner).
 *   • Local .env.local target: additionally requires running locally
 *     (isLocalDev). Writes only the developer's own file — no Vercel creds and
 *     no shared `formEnabled` toggle needed.
 *   • Vercel target: additionally requires the `formEnabled` toggle AND
 *     vercelConfigured() — the path with production blast radius.
 *   • Only writable catalog keys accepted — unknown keys and the preflight
 *     VERCEL_* keys are rejected (no privilege-escalation loop).
 *   • Every value is shape-validated up front; if ANY is malformed the whole
 *     batch is rejected (422) and nothing is written.
 *   • Values are NEVER logged — only key names appear in any log line.
 *   • Does NOT redeploy; the caller hits /redeploy once after all writes.
 */

interface Body {
  vars?: { key?: unknown; value?: unknown }[];
  targets?: { vercel?: unknown; local?: unknown };
}

export async function POST(request: Request) {
  const auth = await requireAgencyOwner(request);
  if (auth instanceof NextResponse) return auth;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(body.vars) || body.vars.length === 0) {
    return NextResponse.json(
      { error: "`vars` must be a non-empty array." },
      { status: 400 },
    );
  }

  // Normalize + validate. Collect problems rather than failing on the first.
  const clean: { key: string; value: string }[] = [];
  const rejected: { key: string; reason: string }[] = [];

  for (const entry of body.vars) {
    const key = typeof entry.key === "string" ? entry.key.trim() : "";
    const value = typeof entry.value === "string" ? entry.value : "";
    if (!key) {
      rejected.push({ key: "(blank)", reason: "missing key name" });
      continue;
    }
    if (!isWritableKey(key)) {
      rejected.push({ key, reason: "not a writable setup key" });
      continue;
    }
    // A variant-scoped key (e.g. the LeadStack founders offset) can't be
    // written on a deployment of a different variant — it isn't surfaced
    // there, so accepting it would be a silent no-op at best.
    const variant = keyVariant(key);
    if (variant && variant !== LANDING_VARIANT) {
      rejected.push({ key, reason: "not available on this deployment" });
      continue;
    }
    if (value.trim() === "") {
      rejected.push({ key, reason: "empty value" });
      continue;
    }
    const shape = validateVar(key, value.trim());
    if (shape) {
      rejected.push({ key, reason: shape });
      continue;
    }
    clean.push({ key, value });
  }

  if (rejected.length > 0) {
    return NextResponse.json(
      { error: "Some values were rejected — nothing was written.", rejected },
      { status: 422 },
    );
  }

  // Resolve targets. Default to Vercel. Local is only honored in dev.
  const wantVercel = body.targets?.vercel !== false; // default true
  const wantLocal = body.targets?.local === true && isLocalDev();

  if (body.targets?.local === true && !isLocalDev()) {
    return NextResponse.json(
      { error: "The .env.local target is only available when running locally." },
      { status: 400 },
    );
  }
  if (!wantVercel && !wantLocal) {
    return NextResponse.json(
      { error: "Select at least one write target." },
      { status: 400 },
    );
  }

  const out: {
    vercel?: { key: string; ok: boolean; action?: string; error?: string }[];
    local?: { key: string; ok: boolean; action?: string; error?: string }[];
  } = {};

  if (wantVercel) {
    // The Vercel write path is gated by the shared toggle (production blast
    // radius); the local path above is not.
    if (!(await readFormEnabled())) {
      return NextResponse.json(
        {
          error:
            "Vercel writes are disabled. Enable the setup form in Agency → Guided setup first.",
        },
        { status: 403 },
      );
    }
    if (!vercelConfigured()) {
      return NextResponse.json(
        { error: "Vercel is not configured on this deployment." },
        { status: 503 },
      );
    }
    try {
      out.vercel = await upsertEnvVars(clean);
    } catch (e) {
      console.error("[agency/setup/env] vercel upsert failed", (e as Error).message);
      return NextResponse.json(
        { error: `Vercel write failed: ${(e as Error).message}` },
        { status: 502 },
      );
    }
  }

  if (wantLocal) {
    out.local = writeEnvLocalVars(clean);
  }

  const anyFailed =
    (out.vercel?.some((r) => !r.ok) ?? false) ||
    (out.local?.some((r) => !r.ok) ?? false);

  // Log key names only — never values.
  console.info(
    "[agency/setup/env] wrote",
    clean.map((v) => v.key).join(", "),
    JSON.stringify({ vercel: wantVercel, local: wantLocal }),
  );

  return NextResponse.json(
    {
      ok: !anyFailed,
      // The Vercel writes need a redeploy to take effect; local writes need a
      // dev-server restart.
      needsRedeploy: wantVercel,
      results: out,
    },
    { status: anyFailed ? 207 : 200 },
  );
}
