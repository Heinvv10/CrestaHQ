import "server-only";

import { NextResponse } from "next/server";
import { requireAgencyOwner } from "@/lib/auth/require-agency-owner";
import { readFormEnabled } from "@/lib/setup/guard";
import { GROUPS, isPresent, isWritableKey, validateVar } from "@/lib/setup/catalog";
import { vercelConfigured, listEnvKeys } from "@/lib/vercel/client";
import { isLocalDev } from "@/lib/setup/env-file";
import { LANDING_VARIANT } from "@/config/landing";

/**
 * Three-state status board for the setup form.
 *
 * Merges two sources per key:
 *   • LIVE   — present in `process.env` (what the running build can use)
 *   • STORED — present in the Vercel env list (what's saved, incl. keys added
 *              but not yet redeployed)
 *
 * Returns states + validity only — never a secret value. The Vercel list is
 * queried for key NAMES only (decrypt: false).
 *
 *   missing  — neither stored nor live        (○)
 *   pending  — stored in Vercel, not yet live  (⏳ redeploy to activate)
 *   active   — live in the running build       (✓, then shape-validated)
 */

type KeyState = "missing" | "pending" | "active";

export async function GET(request: Request) {
  const auth = await requireAgencyOwner(request);
  if (auth instanceof NextResponse) return auth;

  // The board is available whenever the Vercel path is enabled OR we're running
  // locally (where the owner can write .env.local without the toggle).
  if (!isLocalDev() && !(await readFormEnabled())) {
    return NextResponse.json(
      { error: "The setup form is disabled." },
      { status: 403 },
    );
  }

  // Best-effort: if we can't reach Vercel, fall back to live-only detection so
  // the board still renders (stored is then inferred from live).
  let stored: Set<string> | null = null;
  let vercelError: string | null = null;
  if (vercelConfigured()) {
    try {
      const keys = await listEnvKeys();
      stored = new Set(keys.keys());
    } catch (e) {
      vercelError = (e as Error).message;
    }
  }

  const evalKey = (name: string, level: string) => {
    const raw = process.env[name];
    const live = isPresent(raw);
    const isStored = stored ? stored.has(name) : live;
    const state: KeyState = live ? "active" : isStored ? "pending" : "missing";
    // Validity only computable for a value we actually hold (the live one).
    const valid = live ? validateVar(name, (raw ?? "").trim()) === null : null;
    return { name, level, state, valid };
  };

  const groups = GROUPS.filter((g) => g.tier !== "preflight")
    // Variant-scoped groups (e.g. the LeadStack founders deal) only surface on
    // their own deployment; hidden everywhere else.
    .filter((g) => !g.variant || g.variant === LANDING_VARIANT)
    .map((g) => ({
      title: g.title,
      tier: g.tier,
      off: g.off ?? null,
      keys: g.vars
        .filter((v) => isWritableKey(v[0]))
        .map(([name, level]) => evalKey(name, level)),
    }));

  // Preflight (VERCEL_*) — presence ONLY. Read-only in the UI, never writable,
  // and their values are never returned (evalKey emits state, not the value).
  const preflight = GROUPS.filter((g) => g.tier === "preflight").flatMap((g) =>
    g.vars.map(([name, level]) => evalKey(name, level)),
  );

  return NextResponse.json({
    ok: true,
    // null → we couldn't read the Vercel list; the UI can note pending states
    // are approximate.
    storedKnown: stored !== null,
    vercelError,
    groups,
    preflight,
  });
}
